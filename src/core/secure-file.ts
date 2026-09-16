import { mkdirSync, appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
 * `EnigmaError` with that code instead of a raw `SyntaxError`.
 */
export function readJsonFile<T>(path: string, fallback: T, corruptErrorCode?: EnigmaErrorCode): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    if (!corruptErrorCode) throw err;
    throw new EnigmaError({ code: corruptErrorCode, message: `failed to parse ${path}: not valid JSON` });
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
