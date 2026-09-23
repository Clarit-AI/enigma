import { homedir } from 'node:os';
import { join } from 'node:path';

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
 * Interprocess lock file for the index (`mutateIndex` in index-store.ts).
 * Lives next to `index.json`; its presence means another process is inside
 * a critical section that re-reads → applies a delta → writes the index
 * (Issue #66). The file holds `<pid>\n<createdAtMs>\n` at mode 0600 — pid
 * + timestamp only, never a value.
 */
export function indexLockPath(): string {
  return join(enigmaHome(), 'index.lock');
}
