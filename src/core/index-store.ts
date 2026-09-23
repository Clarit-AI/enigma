import { chmodSync, closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EnigmaError } from './errors.js';
import { indexLockPath, indexPath } from './paths.js';
import { readJsonFile, writeJsonFileAtomic } from './secure-file.js';
import type { DepositoryId } from '../storage/interfaces.js';

export type Scope = 'project' | 'global';

export interface IndexEntry {
  name: string;
  scope: Scope;
  /** Present iff scope === 'project'. */
  projectId?: string;
  /** Present iff scope === 'project'; recorded in clear (D1.1). */
  projectPath?: string;
  depository: DepositoryId;
  ref: string;
  description?: string;
  usage?: 'interactive' | 'unattended';
  createdAt: string;
  updatedAt: string;
}

export interface IndexFile {
  version: 1;
  entries: IndexEntry[];
}

export interface IndexEntryView extends IndexEntry {
  /** True when a project entry of the same name shadows this global entry (D1.5). */
  shadowed?: boolean;
}

const EMPTY_INDEX: IndexFile = { version: 1, entries: [] };

/** ref convention (D1.9): "<scopeId>/<NAME>" for every depository except env, which uses the bare NAME. */
export function buildRef(name: string, scope: Scope, projectId?: string): string {
  return scope === 'global' ? `global/${name}` : `${projectId}/${name}`;
}

export function readIndex(): IndexFile {
  return readJsonFile(indexPath(), EMPTY_INDEX, 'E_INDEX_CORRUPT');
}

/**
 * Module-private atomic write. The only legal caller is `mutateIndex` —
 * every public code path that needs to write the index goes through the
 * locked helper so a concurrent writer cannot silently overwrite another
 * writer's just-committed entry (Issue #66). Tests that want to put a
 * specific IndexFile on disk use `mutateIndex((_) => target)` instead of
 * touching this directly.
 */
function writeIndex(index: IndexFile): void {
  writeJsonFileAtomic(indexPath(), index);
}

function sameEntry(entry: IndexEntry, name: string, scope: Scope, projectId?: string): boolean {
  if (entry.name !== name || entry.scope !== scope) return false;
  return scope === 'global' ? true : entry.projectId === projectId;
}

export function findIndexEntry(
  index: IndexFile,
  name: string,
  scope: Scope,
  projectId?: string,
): IndexEntry | undefined {
  return index.entries.find((e) => sameEntry(e, name, scope, projectId));
}

/**
 * Finds the entry for `name` visible from `currentProjectId` when no explicit
 * scope is given: the project entry shadows the global one (D1.5).
 */
export function resolveIndexEntry(
  index: IndexFile,
  name: string,
  scope: Scope | undefined,
  currentProjectId: string | undefined,
): IndexEntry | undefined {
  if (scope) return findIndexEntry(index, name, scope, currentProjectId);
  const projectEntry = currentProjectId ? findIndexEntry(index, name, 'project', currentProjectId) : undefined;
  return projectEntry ?? findIndexEntry(index, name, 'global');
}

export function upsertIndexEntry(index: IndexFile, entry: IndexEntry): IndexFile {
  const others = index.entries.filter((e) => !sameEntry(e, entry.name, entry.scope, entry.projectId));
  return { ...index, entries: [...others, entry] };
}

/**
 * Removes the entry for `name`. When `scope` is omitted and both a project
 * (matching `currentProjectId`) and a global entry exist, throws
 * `E_AMBIGUOUS_SCOPE` (D1.5) instead of guessing.
 */
export function removeIndexEntry(
  index: IndexFile,
  name: string,
  scope: Scope | undefined,
  currentProjectId: string | undefined,
): { index: IndexFile; removed: IndexEntry } {
  if (!scope) {
    const projectEntry = currentProjectId ? findIndexEntry(index, name, 'project', currentProjectId) : undefined;
    const globalEntry = findIndexEntry(index, name, 'global');
    if (projectEntry && globalEntry) {
      throw new EnigmaError({
        code: 'E_AMBIGUOUS_SCOPE',
        message: `${name} exists in both project and global scope; specify --scope`,
        secretName: name,
      });
    }
  }
  const removed = resolveIndexEntry(index, name, scope, currentProjectId);
  if (!removed) {
    throw new EnigmaError({ code: 'E_NOT_FOUND', message: `${name} not found`, secretName: name });
  }
  const entries = index.entries.filter((e) => e !== removed);
  return { index: { ...index, entries }, removed };
}

export function listIndexEntries(
  index: IndexFile,
  opts: { scope?: Scope | 'all'; currentProjectId?: string } = {},
): IndexEntryView[] {
  const scope = opts.scope ?? 'all';
  const entries = scope === 'all' ? index.entries : index.entries.filter((e) => e.scope === scope);
  return entries.map((entry) => {
    if (entry.scope !== 'global') return { ...entry };
    const shadowedBy = opts.currentProjectId
      ? findIndexEntry(index, entry.name, 'project', opts.currentProjectId)
      : undefined;
    return { ...entry, shadowed: Boolean(shadowedBy) };
  });
}

/* ------------------------------------------------------------------ *
 *  Index lock — interprocess critical section for every index write   *
 * ------------------------------------------------------------------ *
 *
 * Issue #66: `writeIndex` is atomic (tmp + rename, secure-file.ts) but not
 * locked. `setSecret` reads the index, awaits the depository write, then
 * writes back its stale copy — a concurrent index write from another MCP or
 * CLI process can therefore be silently lost. Goal: every index writer runs
 * its change inside a short, interprocess-locked critical section that
 * reads the index again before applying it.
 *
 * The lock is `<ENIGMA_HOME>/index.lock`, mode 0600, body `pid\ncreatedAtMs\n`
 * (debug visibility only, never a value). Acquired with `openSync(path, 'wx')`
 * (O_EXCL); if it already exists and is older than LOCK_STALE_MS we treat it
 * as a crashed peer and break it via a tombstone rename so only ONE breaker
 * wins. On bounded-retry exhaustion we throw `E_LOCK_TIMEOUT` — never a
 * silent overwrite.
 */

/** A lock older than this is treated as a crashed peer and broken (Issue #66, AC #3). */
export let LOCK_STALE_MS = 30_000;
/** Per-retry synchronous sleep while the lock is held by a live process. */
export let LOCK_RETRY_INTERVAL_MS = 10;
/** Maximum acquire attempts before throwing `E_LOCK_TIMEOUT` (Issue #66, AC #2). */
export let LOCK_MAX_ATTEMPTS = 50;

/**
 * Test-only: shrink the timing windows so the lock tests don't sit on a
 * 30 s stale wait or a 500 ms retry budget. Always restore the originals
 * in `afterEach` — production reads the values at each acquire call, so a
 * stale test override does not affect subsequent test files, but the
 * convention here is "leave production timings as you found them".
 */
export function __setLockTimingForTesting(opts: {
  staleMs?: number;
  retryIntervalMs?: number;
  maxAttempts?: number;
}): void {
  if (opts.staleMs !== undefined) LOCK_STALE_MS = opts.staleMs;
  if (opts.retryIntervalMs !== undefined) LOCK_RETRY_INTERVAL_MS = opts.retryIntervalMs;
  if (opts.maxAttempts !== undefined) LOCK_MAX_ATTEMPTS = opts.maxAttempts;
}

/**
 * Synchronous sleep — Node has no native `sleepSync`, and a busy-spin on
 * `Date.now()` burns CPU in an MCP process that may be idle otherwise.
 * `Atomics.wait` on a shared Int32Array blocks the worker thread without
 * spinning; this is the documented pattern for cooperative sync waits in
 * Node (the value at index 0 is never written, so the call always times
 * out — we only use the timeout argument as the sleep duration).
 */
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function syncSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

interface Lock {
  readonly path: string;
  release(): void;
}

function acquireIndexLock(): Lock {
  const lockPath = indexLockPath();
  // The parent dir is also ENIGMA_HOME, already created at 0700 by every
  // other write. Re-asserting it here keeps the lock helper robust when
  // it is the first thing to touch ENIGMA_HOME (e.g. immediately after
  // `enigma init` once that exists).
  const dir = dirname(lockPath);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch {
    // Already exists with the right mode, or owned by another user — fall
    // through to openSync and let it surface a clear error if the dir is
    // genuinely missing/unwritable.
  }

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      closeSync(fd);
      fd = undefined;
      return {
        path: lockPath,
        release: () => {
          // Best-effort cleanup. If unlinkSync throws (permission denied,
          // EBUSY, ENOENT from a concurrent breaker, …) we leave the file
          // in place; it will be detected as stale (>30 s) by the next
          // acquire and broken via the tombstone path. Propagating the
          // error here would mask the caller's real outcome — the lock
          // was held for the critical section's full duration, the index
          // was committed atomically, and the only thing we couldn't do
          // was remove a one-line file we own.
          try {
            unlinkSync(lockPath);
          } catch {
            // swallow
          }
        },
      };
    } catch (err) {
      // Close the fd if writeFileSync threw before we had a chance to —
      // otherwise the open fd would leak until GC.
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best-effort */ }
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Lock file exists. Two cases:
      //  - stale: left by a crashed process, break and retry.
      //  - held: another live process is inside its critical section.
      let stat: Stats | undefined;
      try {
        stat = statSync(lockPath);
      } catch (statErr) {
        // Disappeared between EEXIST and statSync — retry openSync immediately.
        if ((statErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw statErr;
      }

      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > LOCK_STALE_MS) {
        // Stale break: rename to a unique tombstone so only ONE breaker's
        // rename wins. The loser's renameSync throws EEXIST, the winner's
        // rename succeeds and unlinks the tombstone. This narrows the
        // residual race between two concurrent breakers to a window between
        // `renameSync` succeeding and the tombstone being unlinked — which
        // is single-threaded inside the same process. The only truly
        // concurrent case is a process crash mid-break, and that is
        // accepted: a stale lock only ever follows a crash inside a
        // critical section that lasts milliseconds (the locked
        // read+delta+write is fully synchronous), so the worst case is one
        // extra round-trip on the next acquire.
        const tombstone = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
        try {
          renameSync(lockPath, tombstone);
        } catch (renameErr) {
          if ((renameErr as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw renameErr;
        }
        try {
          unlinkSync(tombstone);
        } catch {
          // best-effort
        }
        continue;
      }

      // Lock is held by a live process — sleep then retry.
      syncSleep(LOCK_RETRY_INTERVAL_MS);
    }
  }

  throw new EnigmaError({
    code: 'E_LOCK_TIMEOUT',
    message: `Could not acquire ${lockPath} within ${LOCK_MAX_ATTEMPTS * LOCK_RETRY_INTERVAL_MS} ms; another process holds the index lock.`,
  });
}

/**
 * Apply `delta` to the index under an interprocess lock so a concurrent
 * writer can never silently overwrite another writer's just-committed
 * entry (Issue #66). Critical section:
 *
 *   lock → re-read index → delta(current) → write → unlock
 *
 * The body is intentionally synchronous — there is **no `await` of
 * depository I/O inside the lock**. Slow depository work (1Password
 * prompts, keychain operations) belongs in the caller, OUTSIDE the lock.
 * Callers compute their delta from the `current` index passed to the
 * closure, which is the authoritative state at the moment the lock was
 * acquired — a tighter window than `readIndex → slow I/O → writeIndex`,
 * and the only way two concurrent writers can race.
 *
 * The lock is `<ENIGMA_HOME>/index.lock` (`indexLockPath`); see ADR-003 in
 * `docs/architecture.md` for the design rationale and the known
 * limitation around same-name concurrent `set` with `rotate=false`.
 */
export function mutateIndex(delta: (current: IndexFile) => IndexFile): void {
  const lock = acquireIndexLock();
  try {
    const current = readIndex();
    const next = delta(current);
    writeIndex(next);
  } finally {
    lock.release();
  }
}
