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
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, sep } from 'node:path';
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
 * Make sure the lock's parent dir exists, and keep every Enigma-owned dir
 * on the way at `0700` without ever touching a caller's dirs.
 *
 * The rule (one rule, decided on real paths only):
 * - Missing components of the literal path are created one at a time,
 *   so the kernel resolves `..` and symlinks the same way `openSync`
 *   will. A caller that points us at a non-existent path is asking us to
 *   bring it into existence; dirs are created at the umask default.
 * - A dir is chmod-ed to `0700` iff its `realpathSync.native` is inside
 *   the `realpathSync.native` of `enigmaHome()`, checked right after it is
 *   created and once more for the (possibly pre-existing) leaf.
 *
 * So the index lock, the ledger lock and `<enigmaHome>/locks/` end at
 * `0700`, including via a symlinked home or an alias into it, while a
 * dir that is really outside the home keeps whatever mode it has or
 * gets, however the path reached it (trailing slash, relative, `..`,
 * `link/..`, a symlink out of the home). History: review r2 H1/B1, r3
 * symlink escape, r5 alias into home, r6 `link/..`.
 */
function ensureLockDir(lockPath: string): void {
  const dir = dirname(lockPath);

  // Create missing components one at a time on the LITERAL path, so the
  // kernel resolves `..` and symlinks exactly as the later openSync will.
  // Each new dir is judged by its own realpath the moment it exists; no
  // path arithmetic predicts where it lands (review r6). A new dir inside
  // the home sits at the umask default only until the chmod right after
  // its mkdir, while still empty.
  const { root } = parse(dir);
  let prefix = root;
  for (const part of dir.slice(root.length).split(sep)) {
    if (part === '') continue;
    prefix = prefix === '' ? part : prefix.endsWith(sep) ? prefix + part : prefix + sep + part;
    if (existsSync(prefix)) continue;
    try {
      mkdirSync(prefix);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      // Parent is a file, unwritable, etc. — openSync surfaces it with
      // the errno (wrapAcquireError formats errno.code).
      return;
    }
    tightenIfInsideHome(prefix);
  }

  // The leaf may have existed already (e.g. a pre-existing 0755 `locks/`).
  tightenIfInsideHome(dir);
}

/**
 * chmod `dir` to `0700` when its real path is inside the real path of
 * `enigmaHome()`; otherwise leave it alone. Uses `realpathSync.native`
 * (libc `realpath(3)`): the JS `realpathSync` collapses `..` lexically
 * before following symlinks, which disagrees with the kernel for
 * `link/..`. chmod targets the resolved path. Unresolvable → untouched.
 */
function tightenIfInsideHome(dir: string): void {
  let realHome: string;
  let realDir: string;
  try {
    realHome = realpathSync.native(enigmaHome());
    realDir = realpathSync.native(dir);
  } catch {
    return;
  }
  if (!isWithin(realHome, realDir)) return;
  try {
    chmodSync(realDir, 0o700);
  } catch {
    // best-effort: the lock still works at the existing mode.
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
 * is always created; every dir whose real path is inside `enigmaHome()`
 * ends at `0700`, and no dir outside it is chmod-ed (see `ensureLockDir`).
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