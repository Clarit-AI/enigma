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
