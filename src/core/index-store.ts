import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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
 * The lock file is `<ENIGMA_HOME>/index.lock`, mode 0600. Its body is three
 * newline-separated fields:
 *
 *   <token>\n<pid>\n<createdAtMs>\n
 *
 * - `token`: 32-char hex from `crypto.randomBytes(16)` — unique per acquire.
 *   Used to detect that a release is unlinking the lock WE created, not a
 *   lock a stale-break replacement put in its place.
 * - `pid`: debugging only (never a value, just identifies the holding
 *   process).
 * - `createdAtMs`: the wall-clock instant the lock was acquired. The
 *   stale-break path reads this from a tombstone to verify the stolen lock
 *   really was stale before unlinking it; a live lock stolen by mistake is
 *   restored via `linkSync` rather than unlinked.
 *
 * Acquisition uses `openSync(path, 'wx')` (O_EXCL). On `EEXIST`, the file is
 * either live (held by another process) or stale (left by a crashed one).
 * Stale locks are broken via a tombstone `renameSync` followed by an
 * in-content age check (so a lock whose `stat.mtimeMs` looked stale but
 * whose own `createdAtMs` is recent — i.e. we stole a live lock — is
 * restored, not unlinked). Two concurrent breakers race on the rename: the
 * winner unlinks the tombstone and proceeds, the loser sees `ENOENT` (the
 * source has already been moved) and retries the open. Tombstone-name
 * collisions are vanishingly rare but also retry safely via `EEXIST`.
 *
 * The lock is released in `finally`; the release only unlinks if the file
 * still carries the acquirer's token. The read-then-unlink window is
 * small (a few microseconds) and accepted: if a stale-break replacement
 * happens between the read and the unlink, we leave the new owner's lock
 * alone.
 *
 * No raw `node:fs` error may escape `mutateIndex`. Anything unexpected from
 * `acquireIndexLock` is wrapped in `EnigmaError` with `E_LOCK_TIMEOUT` (the
 * lock acquisition failed, and that's the most accurate code for an
 * unexpected fs failure mid-acquire — the caller's only recourse is to
 * retry or surface the lock-acquisition failure). The user's `delta`
 * closure and `writeIndex` keep their own error handling.
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
  /**
   * Unlinks the lock file iff it still carries the token this Lock was
   * acquired with. The check-then-unlink window is small (a few
   * microseconds); if a stale-break replacement lands in that window, the
   * new owner's lock is left alone.
   */
  release(): void;
}

/**
 * Best-effort mkdir+chmod of the parent dir. ENOENT/EEXIST are
 * expected — the dir already exists at the right mode from any prior
 * Enigma write. Anything else is wrapped.
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
 * Reads the lock file's body and returns the parsed token/pid/createdAtMs,
 * or `undefined` if the file is unreadable / malformed. Never throws.
 */
function readLockBody(lockPath: string): { token: string; pid: string; createdAtMs: number } | undefined {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const lines = raw.split('\n');
    const token = lines[0] ?? '';
    const pid = lines[1] ?? '';
    const createdAtMs = Number(lines[2] ?? Number.NaN);
    if (!token || !Number.isFinite(createdAtMs)) return undefined;
    return { token, pid, createdAtMs };
  } catch {
    return undefined;
  }
}

/**
 * Wrap any unexpected fs error from the acquire path as `E_LOCK_TIMEOUT`.
 * The acquirer's only recourse on a hard fs failure is to surface the
 * lock-acquisition error, and `E_LOCK_TIMEOUT` is the closest code we have
 * — the message names the cause via the original error's constructor name.
 */
function wrapAcquireError(err: unknown, lockPath: string): EnigmaError {
  const cause = err instanceof Error ? err.constructor.name : String(err);
  return new EnigmaError({
    code: 'E_LOCK_TIMEOUT',
    message: `Failed to acquire ${lockPath}: ${cause}`,
  });
}

function acquireIndexLock(): Lock {
  const lockPath = indexLockPath();
  ensureLockDir(lockPath);

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw wrapAcquireError(err, lockPath);
      }
      // EEXIST — someone else holds (or crashed holding) the lock. `fd` is
      // still `undefined`, so we fall through to the "determine live vs
      // stale" branch below. Crucially: we have NOT touched the existing
      // file in any way here — only openSync failing tells us it exists,
      // and generating a token/writing/unlinking must never happen on this
      // path, or we'd be deleting a lock we don't own.
    }

    if (fd !== undefined) {
      // openSync succeeded: the lock file is ours, empty, mode 0600. From
      // here, any failure must unlink it (lock-leak fix) rather than leave
      // an orphaned, ownerless lock file on disk for the next acquirer to
      // trip over.
      const token = randomBytes(16).toString('hex');
      let bodyWritten = false;
      try {
        writeFileSync(fd, `${token}\n${process.pid}\n${Date.now()}\n`);
        bodyWritten = true;
        closeSync(fd);
      } catch (err) {
        if (!bodyWritten) {
          try { closeSync(fd); } catch { /* fd already invalid */ }
        }
        try { unlinkSync(lockPath); } catch { /* best-effort */ }
        throw wrapAcquireError(err, lockPath);
      }

      // We hold the lock. Return the release handle.
      return {
        path: lockPath,
        release: () => {
          try {
            const current = readLockBody(lockPath);
            if (current && current.token === token) {
              try { unlinkSync(lockPath); } catch { /* best-effort */ }
            }
            // Token mismatch → a stale-break replacement put a new owner's
            // lock here; leave it alone.
          } catch {
            // best-effort
          }
        },
      };
    }

    // EEXIST path — lock file already exists. Determine live vs stale.
    let body: ReturnType<typeof readLockBody>;
    try {
      body = readLockBody(lockPath);
    } catch (err) {
      throw wrapAcquireError(err, lockPath);
    }
    if (!body) {
      // File disappeared between EEXIST and our read — retry the open.
      continue;
    }

    const ageMs = Date.now() - body.createdAtMs;
    if (ageMs > LOCK_STALE_MS) {
      // Stale break. Rename to a unique tombstone so only ONE breaker's
      // rename wins; the other breaker sees ENOENT (source moved) and
      // retries the open.
      const tombstone = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
      try {
        renameSync(lockPath, tombstone);
      } catch (renameErr) {
        const code = (renameErr as NodeJS.ErrnoException).code;
        // ENOENT: another breaker moved the source out from under us.
        // EEXIST: tombstone-name collision (vanishingly rare with randomBytes).
        // Either way, retry the open.
        if (code === 'ENOENT' || code === 'EEXIST') continue;
        throw wrapAcquireError(renameErr, lockPath);
      }

      // Verify we didn't steal a live lock. If the tombstone's recorded
      // `createdAtMs` is still within the stale threshold, the lock was
      // alive when we stole it; restore it via linkSync, back off, and
      // retry. linkSync failing with EEXIST means someone else already
      // recreated the lock at `lockPath` — fine, leave their lock alone.
      const tombstoneBody = readLockBody(tombstone);
      if (
        tombstoneBody &&
        Date.now() - tombstoneBody.createdAtMs <= LOCK_STALE_MS
      ) {
        try { linkSync(tombstone, lockPath); } catch { /* EEXIST fine */ }
        try { unlinkSync(tombstone); } catch { /* best-effort */ }
        syncSleep(LOCK_RETRY_INTERVAL_MS);
        continue;
      }

      // Legitimate stale break.
      try { unlinkSync(tombstone); } catch { /* best-effort */ }
      continue;
    }

    // Lock is held by a live process — sleep then retry.
    syncSleep(LOCK_RETRY_INTERVAL_MS);
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
