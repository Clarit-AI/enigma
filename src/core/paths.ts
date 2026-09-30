import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EnigmaError } from './errors.js';

/** Root directory for all Enigma state; overridable for tests via ENIGMA_HOME. */
export function enigmaHome(): string {
  return process.env.ENIGMA_HOME || join(homedir(), '.config', 'enigma');
}

export function indexPath(): string {
  return join(enigmaHome(), 'index.json');
}

export function auditLogPath(): string {
  return join(enigmaHome(), 'audit.log');
}

export function configPath(): string {
  return join(enigmaHome(), 'config.json');
}

export function keyPath(): string {
  return join(enigmaHome(), 'enigma.key');
}

export function secretsPath(): string {
  return join(enigmaHome(), 'secrets.enc');
}

/**
 * Persistent anchor file for the index lock (`mutateIndex` in
 * index-store.ts). Lives next to `index.json`. Created ONCE at mode 0600
 * and never renamed, unlinked, or replaced; exclusion is a kernel
 * `flock(2)` on the open file description (Issue #66), not anything read
 * from the file's name or body. The body (`<pid>\n<createdAtMs>\n`) is
 * optional informational metadata written after the lock is held — pid +
 * timestamp only, never a value, never read for safety.
 */
export function indexLockPath(): string {
  return join(enigmaHome(), 'index.lock');
}

/* ------------------------------------------------------------------ *
 *  Render ledger (Issue #106)                                         *
 * ------------------------------------------------------------------ *
 *
 * The render ledger records, per (projectId, worktree, file) target, the
 * names last rendered there and when. It is NAMES-only — values never
 * appear in it. Each render-target lock anchor lives under the same
 * `enigmaHome()` (which honours `ENIGMA_HOME`), so the test sandbox and
 * a real install both find the ledger and its anchors in the obvious place.
 *
 * The ledger file itself is a small JSON document at
 * `<enigmaHome>/render-ledger.json`, mode `0600`, written atomically
 * (`writeJsonFileAtomic`) under a ledger-owned `acquireFileLock` RMW
 * critical section — see `src/render/ledger.ts`.
 */
export function renderLedgerPath(): string {
  return join(enigmaHome(), 'render-ledger.json');
}

/**
 * Lock anchor for the ledger itself (Issue #106). A SEPARATE file from
 * the ledger — the ledger is JSON and the lock is a kernel-flavored
 * `flock(2)` anchor with an opaque body. `acquireFileLock` opens this
 * file with `O_EXCL` to create it on first use; the JSON ledger is
 * written via `writeJsonFileAtomic` under that lock.
 */
export function renderLedgerLockPath(): string {
  return join(enigmaHome(), 'render-ledger.lock');
}

/**
 * Anchor path for a single render target (Issue #106 AC #3).
 *
 * The anchor name MUST be stable for the lifetime of the target —
 * otherwise two renders could run concurrently on the same file (one
 * pre-creation / one post-creation), or on the same file reached via a
 * symlinked directory (e.g. macOS `/tmp` → `/private/tmp`, a symlinked
 * worktree root). Anchor stability is the whole reason the clarification
 * comment requires this derivation: two worktrees that both have a
 * relative `.env` must NOT contend on the same anchor.
 *
 * Derivation: `realpathSync(dirname(target))` joined with `basename(target)`.
 * The directory must exist by the time we are about to write into the
 * target — if `realpathSync(dirname(...))` fails, the write would fail
 * anyway, and we throw `E_WRITE_FAILED` so the failure surfaces with a
 * stable code and a path-naming message rather than a raw `ENOENT`
 * leaking later.
 *
 * Hash: sha256 of the joined string, first 32 hex chars
 * (`createHash('sha256').update(key).digest('hex').slice(0, 32)`). 32
 * hex chars is 128 bits — well above the birthday-collision bound for
 * any realistic number of anchors in one install, and short enough that
 * the resulting filename stays under POSIX `NAME_MAX`.
 */
export function renderLockPath(targetPath: string): string {
  const targetDir = dirname(targetPath);
  let dirAbs: string;
  try {
    dirAbs = realpathSync(targetDir);
  } catch (err) {
    throw new EnigmaError({
      code: 'E_WRITE_FAILED',
      message: `Cannot resolve lock anchor for ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  const key = join(dirAbs, basename(targetPath));
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return join(enigmaHome(), 'locks', `${hash}.lock`);
}