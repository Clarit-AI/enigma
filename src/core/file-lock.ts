/* ------------------------------------------------------------------ *
 *  Generic interprocess file lock — Issue #106                       *
 * ------------------------------------------------------------------ *
 *
 * `acquireFileLock(lockPath)` is the kernel-held, interprocess exclusion
 * primitive the rest of the codebase builds short critical sections on.
 * It supersedes the inline block that lived in `src/core/index-store.ts`
 * (Issue #66's `acquireIndexLock`); that helper is now a one-liner that
 * calls this one with `indexLockPath()`. Nothing about the exclusion
 * mechanism changes — same kernel `flock(2)` via the first-party N-API
 * addon, same create-once persistent anchor, same `E_LOCK_TIMEOUT` shape,
 * same `finally`-release + fd cleanup. The only difference is that the
 * anchor path is now passed in: any caller that wants kernel-held
 * exclusion on a file in the Enigma config dir (or anywhere else) can
 * name the file and get the same protocol.
 *
 * Mechanism (kernel descriptor lock): exclusion is a `flock(LOCK_EX |
 * LOCK_NB)` on the open file description through the first-party N-API
 * addon `native/index-lock.cc` (committed per-platform under
 * `plugins/enigma/native/<os>-<arch>/`). Unsupported platforms fail
 * closed with `E_LOCK_UNAVAILABLE` — there is no pure-JS fallback by
 * design.
 *
 * Anchor invariants:
 * - Created ONCE (`O_EXCL`); the inode is never renamed, unlinked, or
 *   replaced for the lifetime of the install — the kernel ties the
 *   lock to the open file description, so the inode must be stable.
 * - Acquire = bounded non-blocking retry loop with `Atomics.wait`
 *   sleep (no busy-spin). Exhaustion → `E_LOCK_TIMEOUT` naming the
 *   path.
 * - Release = `flock(LOCK_UN)` + `close(fd)` in `finally`. It never
 *   touches the file's name or body.
 * - The body (`<pid>\n<createdAtMs>\n`) is OPTIONAL informational
 *   metadata written after the lock is held, via the held fd. Never
 *   read for safety; a leftover legacy body is overwritten on the next
 *   successful acquire.
 * - Crash recovery is the kernel's: the lock dies with the process
 *   — any death, including SIGKILL — so a crashed holder can never
 *   wedge the file. A paused but ALIVE holder is waited out, never
 *   evicted.
 *
 * Index-specific notes (writer set, upgrade protocol, ADR-003 /
 * Issue #70 limitation) live next to `acquireIndexLock` in
 * `src/core/index-store.ts`.
 */
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { EnigmaError } from './errors.js';
import { loadIndexLock } from './native-lock.js';
import { enigmaHome } from './paths.js';

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

export interface Lock {
  /** `flock(LOCK_UN)` + `close(fd)`. Never deletes or replaces the anchor. */
  release(): void;
}

/**
 * Make sure the lock's parent dir exists, without loosening anything
 * Enigma owns or tightening anything it doesn't.
 *
 * Contract (scoped to what callers need; matches the pre-#106 index
 * lock, which created its dir at 0700 and tightened the leaf):
 * - Missing components of the LITERAL path are created one at a time,
 *   so the kernel resolves `..` and symlinks the same way `openSync`
 *   will. Each is born no more permissive than `0700` (mkdir mode
 *   `0700`, further narrowed by the umask); once it exists, its real path
 *   decides its final mode: inside the home → set to exactly `0700`;
 *   outside → relaxed to the umask default, as a plain mkdir would have
 *   made it. So no dir inside the home is ever looser than `0700`, even
 *   for an instant.
 * - The leaf (possibly pre-existing, e.g. a `0755` `locks/`) is
 *   tightened to `0700` when its real path is inside the home.
 * - Pre-existing INTERMEDIATE dirs are left as they are. Every caller
 *   builds its path from `enigmaHome()` (the home itself, or `locks/`
 *   under it), so there is no intermediate between the home and the leaf.
 * - "Inside the home" = `realpathSync.native(dir)` is within
 *   `realpathSync.native(resolve(enigmaHome()))`. The home side is
 *   `resolve()`d first because `paths.ts` builds every lock path with
 *   `join(enigmaHome(), …)`, which collapses `..` lexically; the dir side
 *   stays literal because that is what the kernel opens. Only directories
 *   are ever chmod-ed.
 *
 * History: review r2 H1/B1 (trailing slash), r3 (symlink escape), r5
 * (alias into home), r6 (`link/..` in the lock path), r7 (born no looser than 0700,
 * `link/..` in ENIGMA_HOME).
 */
function ensureLockDir(lockPath: string): void {
  const dir = dirname(lockPath);

  const { root } = parse(dir);
  let prefix = root;
  for (const part of dir.slice(root.length).split(sep)) {
    if (part === '') continue;
    prefix = prefix === '' ? part : prefix.endsWith(sep) ? prefix + part : prefix + sep + part;
    if (existsSync(prefix)) continue;
    try {
      mkdirSync(prefix, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      // Parent is a file, unwritable, etc. — openSync surfaces it with
      // the errno (wrapAcquireError formats errno.code).
      return;
    }
    // Born 0700; now that it exists, settle its final mode by real path.
    if (!tightenIfInsideHome(prefix)) relaxToUmaskDefault(prefix);
  }

  tightenIfInsideHome(dir);
}

/**
 * chmod `dir` to `0700` when it is a directory whose real path is inside
 * the home (see `ensureLockDir` for the definition). Returns whether it
 * was inside. Uses `realpathSync.native` (libc `realpath(3)`): the JS
 * `realpathSync` collapses `..` lexically before following symlinks,
 * which disagrees with the kernel for `link/..`. Unresolvable → outside.
 */
function tightenIfInsideHome(dir: string): boolean {
  let realHome: string;
  let realDir: string;
  try {
    realHome = realpathSync.native(resolve(enigmaHome()));
    realDir = realpathSync.native(dir);
    if (!statSync(realDir).isDirectory()) return false;
  } catch {
    return false;
  }
  if (!isWithin(realHome, realDir)) return false;
  try {
    chmodSync(realDir, 0o700);
  } catch {
    // best-effort: the lock still works at the existing mode.
  }
  return true;
}

/** Give a dir we just created outside the home the mode a plain mkdir would have. */
function relaxToUmaskDefault(dir: string): void {
  try {
    chmodSync(dir, 0o777 & ~process.umask());
  } catch {
    // best-effort: staying at 0700 is only stricter than asked.
  }
}

/** True when `child` is `parent` or below it, split on a separator boundary (so `..x` is below). */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Wrap any unexpected fs/native error from the acquire path as
 * `E_LOCK_TIMEOUT`. The acquirer's only recourse on a hard failure is to
 * surface the lock-acquisition error, and `E_LOCK_TIMEOUT` is the closest
 * code we have — the message names the cause via the original error's
 * constructor name plus its errno `code` when present, so an operator
 * can tell ENOENT (parent dir missing) from EACCES (no write
 * permission) from a bare fs failure. The errno `code` is the most
 * useful piece of a `node:fs` error for triage, and we never include
 * the error's `message` body (could echo a path or value).
 */
function wrapAcquireError(err: unknown, lockPath: string): EnigmaError {
  const causeName = err instanceof Error ? err.constructor.name : String(err);
  const errno = err instanceof Error && 'code' in err && typeof (err as NodeJS.ErrnoException).code === 'string'
    ? ` (${(err as NodeJS.ErrnoException).code})`
    : '';
  return new EnigmaError({
    code: 'E_LOCK_TIMEOUT',
    message: `Failed to acquire ${lockPath}: ${causeName}${errno}`,
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

/**
 * Acquire a kernel-held interprocess lock on `lockPath`.
 *
 * `label` is the noun that the timeout message uses for the lock
 * (default `"the lock"`); the index-lock caller passes `"the index lock"`
 * so the message exactly matches the pre-Issue-#106 baseline ("…
 * another process holds the index lock."). The label is purely
 * cosmetic — it changes no behavior.
 *
 * Returns a `Lock` whose `release()` MUST be called in `finally` (the
 * pattern `mutateIndex` already follows). Throws `E_LOCK_TIMEOUT` if the
 * retry budget is exhausted, wrapping the underlying fs/native error in
 * the message; never lets a raw `node:fs` error escape.
 *
 * The anchor at `lockPath` is created on first use at mode `0600`; its
 * inode is stable for the lifetime of the install. A missing parent dir
 * is always created. Dirs it creates and the leaf end at `0700` when their
 * real path is inside `enigmaHome()`; a dir it creates outside gets the
 * umask default; no pre-existing dir outside is chmod-ed (see
 * `ensureLockDir`).
 */
export function acquireFileLock(lockPath: string, label: string = 'the lock'): Lock {
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
      message: `Could not acquire ${lockPath} within ${LOCK_MAX_ATTEMPTS * LOCK_RETRY_INTERVAL_MS} ms; another process holds ${label}.`,
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