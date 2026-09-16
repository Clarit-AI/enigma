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
