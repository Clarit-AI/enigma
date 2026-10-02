import { existsSync, mkdirSync, appendFileSync, chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EnigmaError, type EnigmaErrorCode } from './errors.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}

/**
 * Reads and parses a JSON file, returning `fallback` when it doesn't exist.
 * When `corruptErrorCode` is given, an unparsable file throws an
 * `EnigmaError` with that code instead of a raw `SyntaxError` — the single
 * place every on-disk JSON file's corruption is turned into the same shape
 * of answer (which file, what is wrong, what to do), matching the precedent
 * `E_CLAUDE_SETTINGS_INVALID` already set for `settings.json` (Issue #18).
 * `corruptDepository` names the depository the file belongs to (e.g.
 * `encrypted` for `secrets.enc`), when the file has one.
 */
export function readJsonFile<T>(path: string, fallback: T, corruptErrorCode?: EnigmaErrorCode, corruptDepository?: string): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    if (!corruptErrorCode) throw err;
    throw new EnigmaError({
      code: corruptErrorCode,
      message: `${path} is not valid JSON. Fix or remove it by hand, then try again.`,
      depository: corruptDepository,
    });
  }
}

/** Writes JSON atomically (tmp file + rename) at mode 0600, creating the parent dir at 0700. */
export function writeJsonFileAtomic(path: string, data: unknown): void {
  ensureParentDir(path);
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: FILE_MODE });
  chmodSync(tmpPath, FILE_MODE);
  renameSync(tmpPath, path);
}

/** Appends one line to a 0600 file, creating it (and its 0700 parent dir) on first use. */
export function appendLineSecure(path: string, line: string): void {
  ensureParentDir(path);
  appendFileSync(path, `${line}\n`, { mode: FILE_MODE });
}

/* ------------------------------------------------------------------ *
 *  Atomic file write at 0600 (Issue #107 + #13)                        *
 * ------------------------------------------------------------------ *
 *
 * Temp file + rename in the same directory as `path` (so the rename is
 * atomic on the same filesystem). Used wherever a whole-file rewrite
 * would risk tearing the file's content — `enigma import` rewrites the
 * user's `.env` (which may carry credentials this command was never
 * asked to touch, Issue #13 review round 2 A1) and `enigma render`
 * rewrites the same `.env` with the managed render block (Issue #107).
 * The accepted exception to the codebase's "never a temp file" rule —
 * a partial render-block write could lose both names and values.
 *
 * Never throws: a write or rename failure is reported via the return
 * value so the caller can fold it into `warnings[]` rather than crash.
 * On failure, always attempts to unlink the temp file — leaving a 0600
 * plaintext copy of the whole file in the project directory is exactly
 * what a later `git add -A` would sweep up, and it must never happen
 * silently (Issue #13 review round 3 item 2).
 */
export interface AtomicWriteResult {
  ok: boolean;
  /** Set iff !ok: the write/rename failure, safe to surface (filesystem error text, not file content). */
  error?: string;
  /** Set iff !ok AND the leftover temp file (holding the FULL rewritten content — every other secret in the file, not just the migrated ones) could not be cleaned up either. Names the path so the caller can warn the user rather than leaving a plaintext file silently sitting in the project directory. */
  leftoverPath?: string;
}

export function writeFileAtomic(path: string, content: string, mode: number): AtomicWriteResult {
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, content, { mode });
    renameSync(tmpPath, path);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
      return { ok: false, error };
    } catch {
      return { ok: false, error, leftoverPath: tmpPath };
    }
  }
}
