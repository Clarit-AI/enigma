import { join } from 'node:path';
import { configPath } from './paths.js';
import { readJsonFile } from './secure-file.js';
import type { DepositoryId } from '../storage/interfaces.js';

export interface EnigmaConfig {
  defaultDepository?: DepositoryId;
  remote?: 'cloudflared' | 'tailscale';
  tripwire?: { depositories: DepositoryId[] };
  ui?: 'web' | 'native';
}

export interface ProjectManifest {
  defaultDepository?: DepositoryId;
  secrets: Record<string, string>;
}

const DEFAULT_CONFIG: EnigmaConfig = {};
const DEFAULT_MANIFEST: ProjectManifest = { secrets: {} };

/** Loads `~/.config/enigma/config.json`; unknown keys are ignored; a missing file yields defaults. Corrupt JSON raises `E_CONFIG_CORRUPT` (Issue #18) rather than a raw `SyntaxError`. */
export function loadConfig(): EnigmaConfig {
  const raw = readJsonFile<Record<string, unknown> | undefined>(configPath(), undefined, 'E_CONFIG_CORRUPT');
  if (!raw) return { ...DEFAULT_CONFIG };
  const config: EnigmaConfig = {};
  if (typeof raw.defaultDepository === 'string') config.defaultDepository = raw.defaultDepository as DepositoryId;
  if (raw.remote === 'cloudflared' || raw.remote === 'tailscale') config.remote = raw.remote;
  if (raw.tripwire && typeof raw.tripwire === 'object' && Array.isArray((raw.tripwire as { depositories?: unknown }).depositories)) {
    config.tripwire = { depositories: (raw.tripwire as { depositories: DepositoryId[] }).depositories };
  }
  if (raw.ui === 'web' || raw.ui === 'native') config.ui = raw.ui;
  return config;
}

/** Loads the committed project manifest `.enigma.json`; unknown keys ignored; missing file yields defaults. Corrupt JSON raises `E_CONFIG_CORRUPT` (Issue #18) rather than a raw `SyntaxError`. */
export function loadProjectManifest(projectPath: string): ProjectManifest {
  const raw = readJsonFile<Record<string, unknown> | undefined>(join(projectPath, '.enigma.json'), undefined, 'E_CONFIG_CORRUPT');
  if (!raw) return { ...DEFAULT_MANIFEST, secrets: {} };
  const manifest: ProjectManifest = { secrets: {} };
  if (typeof raw.defaultDepository === 'string') manifest.defaultDepository = raw.defaultDepository as DepositoryId;
  if (raw.secrets && typeof raw.secrets === 'object') {
    for (const [name, description] of Object.entries(raw.secrets as Record<string, unknown>)) {
      if (typeof description === 'string') manifest.secrets[name] = description;
    }
  }
  return manifest;
}
