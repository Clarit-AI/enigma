import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configPath } from './paths.js';
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

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Loads `~/.config/enigma/config.json`; unknown keys are ignored; a missing file yields defaults. */
export function loadConfig(): EnigmaConfig {
  const raw = readJsonIfExists(configPath());
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

/** Loads the committed project manifest `.enigma.json`; unknown keys ignored; missing file yields defaults. */
export function loadProjectManifest(projectPath: string): ProjectManifest {
  const raw = readJsonIfExists(join(projectPath, '.enigma.json'));
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
