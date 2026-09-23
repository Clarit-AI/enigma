import { chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { EnigmaError } from './errors.js';
import { loadIndexLock } from './native-lock.js';
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
 *  Index lock — kernel-held critical section for every index write    *
 * ------------------------------------------------------------------ *
 *
 * Issue #66: `writeIndex` is atomic (tmp + rename, secure-file.ts) but not
 * locked. `setSecret` reads the index, awaits the depository write, then
 * writes back its stale copy — a concurrent index write from another MCP or
 * CLI process can therefore be silently lost. Goal: every index writer runs
 * its change inside a short, interprocess-locked critical section that
 * reads the index again before applying it.
 *
 * Mechanism (superseding the earlier name-based O_EXCL + stale-threshold
 * protocol, which is removed in full): exclusion is a kernel `flock(2)` on
 * a PERSISTENT anchor file at `<ENIGMA_HOME>/index.lock` (mode 0600),
 * through the first-party N-API addon (`native/index-lock.cc`, committed
 * per-platform under `plugins/enigma/native/<os>-<arch>/`). There is no
 * pure-JS fallback — unsupported platforms fail closed with
 * `E_LOCK_UNAVAILABLE` rather than running a second, weaker protocol.
 *
 * Invariants:
 * - The anchor is created ONCE (`openSync(path, 'wx', 0o600)`; `EEXIST` →
 *   open the existing file). It is NEVER renamed, unlinked, or replaced —
 *   including at release. The kernel ties the lock to the open file
 *   description, so the inode must be stable; deleting the name would let
 *   two holders end up on different inodes.
 * - Acquire = `flock(fd, LOCK_EX | LOCK_NB)` in a bounded retry loop with
 *   `Atomics.wait` sleep (no busy-spin). Exhaustion → `E_LOCK_TIMEOUT`
 *   naming the path (Issue #66, AC #2). Unexpected fs/native errors during
 *   acquire are wrapped the same way — no raw `node:fs` error escapes
 *   `mutateIndex`.
 * - Release = `flock(fd, LOCK_UN)` + `close(fd)`, run in `finally` (Issue
 *   #66, AC #1). It never touches the file's name or body.
 * - Crash recovery is the kernel's (Issue #66, AC #3): the lock dies with
 *   the process — any death, including SIGKILL — so a crashed holder can
 *   never wedge the index and no staleness heuristic is needed. A paused
 *   but ALIVE owner is waited out and never evicted.
 * - The body (`<pid>\n<createdAtMs>\n`) is OPTIONAL INFORMATIONAL
 *   metadata written after the lock is held, via the held fd. It is never
 *   read for safety; a leftover legacy body (empty, partial, or old-format)
 *   is simply overwritten on the next successful acquire.
 *
 * Assumptions / scope (documented, not assumed away):
 * - flock is ADVISORY: exclusion holds among cooperating processes. Every
 *   index writer — `setSecret`, `deleteSecret`, `move` (via `setSecret(…,
 *   rotate: true)`), `import-commit` (via per-entry `setSecret`) — goes
 *   through this helper, so the cooperating set is exactly Enigma's
 *   writers. Slow depository I/O (1Password prompts, keychain) stays OUT
 *   of the critical section.
 * - Upgrade is stop/restart ALL writers: a long-running MCP server keeps
 *   the old protocol in memory until it restarts. There is NO
 *   mixed-protocol guarantee — a process running the removed name-based
 *   protocol can unlink/replace the anchor and split exclusion across two
 *   inodes. `enigma doctor` can hint at running writers; it does NOT prove
 *   they are all stopped.
 * - Known limitation (unchanged): two concurrent `set` calls with
 *   `rotate=false` for the same name may leave the loser's value as an
 *   orphan in the depository; see `docs/architecture.md` ADR-003 and
 *   Issue #70.
 */
/** Per-retry synchronous sleep while the lock is held by a live process. */
export let LOCK_RETRY_INTERVAL_MS = 10;
/** Maximum acquire attempts before throwing `E_LOCK_TIMEOUT` (Issue #66, AC #2). */
export let LOCK_MAX_ATTEMPTS = 50;

/**
 * Test-only: shrink the retry budget so lock tests don't sit on a 500 ms
 * bounded wait. Restore in `afterEach` — production reads the values at
 * each acquire call.
 */
export function __setLockTimingForTesting(opts: {
  retryIntervalMs?: number;
  maxAttempts?: number;
}): void {
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
  /** `flock(LOCK_UN)` + `close(fd)`. Never deletes or replaces the anchor. */
  release(): void;
}

/**
 * Best-effort mkdir+chmod of the parent dir. ENOENT/EEXIST are
 * expected — the dir already exists at the right mode from any prior
 * Enigma write. Anything else is swallowed here and surfaces from the
 * open below if the dir is genuinely missing/unwritable.
 */
function ensureLockDir(lockPath: string): void {
  const dir = dirname(lockPath);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch {
    // Already exists at the right mode, or owned by another user — fall
    // through to openSync and let it surface a clear error if the dir is
    // genuinely missing/unwritable.
  }
}

/**
 * Wrap any unexpected fs/native error from the acquire path as
 * `E_LOCK_TIMEOUT`. The acquirer's only recourse on a hard failure is to
 * surface the lock-acquisition error, and `E_LOCK_TIMEOUT` is the closest
 * code we have — the message names the cause via the original error's
 * constructor name.
 */
function wrapAcquireError(err: unknown, lockPath: string): EnigmaError {
  const cause = err instanceof Error ? err.constructor.name : String(err);
  return new EnigmaError({
    code: 'E_LOCK_TIMEOUT',
    message: `Failed to acquire ${lockPath}: ${cause}`,
  });
}

/**
 * Opens the PERSISTENT anchor. Create-once semantics: `wx` (O_EXCL) on the
 * first ever acquire, plain open afterwards. The inode created here is
 * never renamed, unlinked, or replaced for the lifetime of the install.
 */
function openAnchor(lockPath: string): number {
  try {
    return openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw wrapAcquireError(err, lockPath);
    }
  }
  try {
    return openSync(lockPath, 'r+');
  } catch (err) {
    throw wrapAcquireError(err, lockPath);
  }
}

/**
 * OPTIONAL informational metadata, written only after the lock is held and
 * only through the held fd. Never read for safety; failures are silently
 * ignored (the lock itself is already ours at this point).
 */
function writeInfoMetadata(fd: number): void {
  try {
    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid}\n${Date.now()}\n`, 0);
  } catch {
    // informational only
  }
}

function acquireIndexLock(): Lock {
  const lockPath = indexLockPath();
  ensureLockDir(lockPath);
  const addon = loadIndexLock();
  const fd = openAnchor(lockPath);
  try {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
      if (addon.tryLockSync(fd)) {
        writeInfoMetadata(fd);
        return {
          release: () => {
            try {
              addon.unlockSync(fd);
            } catch {
              // best-effort: close below still runs
            }
            try {
              closeSync(fd);
            } catch {
              // best-effort
            }
          },
        };
      }
      // Held by a live peer (or a paused one) — sleep then retry. A holder
      // that dies gets released by the kernel, so a retry can always win.
      syncSleep(LOCK_RETRY_INTERVAL_MS);
    }
    throw new EnigmaError({
      code: 'E_LOCK_TIMEOUT',
      message: `Could not acquire ${lockPath} within ${LOCK_MAX_ATTEMPTS * LOCK_RETRY_INTERVAL_MS} ms; another process holds the index lock.`,
    });
  } catch (err) {
    // fd cleanup on every non-success path (AC: no fd leak).
    try {
      closeSync(fd);
    } catch {
      // best-effort
    }
    if (err instanceof EnigmaError) throw err;
    throw wrapAcquireError(err, lockPath);
  }
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
 * acquired.
 *
 * The lock is a kernel flock on the persistent `<ENIGMA_HOME>/index.lock`
 * anchor (`indexLockPath`); see ADR-003 in `docs/architecture.md` for the
 * mechanism decision, the stop/restart-all-writers upgrade requirement, and
 * the known limitation around same-name concurrent `set` with
 * `rotate=false`.
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
