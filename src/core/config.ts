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

/**
 * Render-overrides carried in `.enigma.json` (Issue #107). All fields
 * optional; missing `render` key → defaults (enabled, `.env`, no
 * narrowing). Unknown sub-keys are ignored at parse time so a future
 * sub-key never silently activates.
 *
 * `enabled: false` keeps the renderer from writing anything — the
 * renderer still runs, surfaces "rendering is off", and exits 0 (the
 * SessionStart hook and doctor both surface the off-state the same
 * way). `path` is always resolved relative to the project root and
 * is rejected when absolute, lexically escaping, or symlink-escaping
 * (renderer enforces those; this parser only narrows the type).
 *
 * `names` narrows the render set: when present, ONLY these names are
 * eligible — every other project secret is left out of the block
 * (and removed from the block if it was previously in it).
 */
export interface ProjectManifestRender {
  enabled?: boolean;
  path?: string;
  names?: string[];
}

export interface ProjectManifest {
  defaultDepository?: DepositoryId;
  secrets: Record<string, string>;
  render?: ProjectManifestRender;
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

/**
 * Parse the `render` sub-object (Issue #107). Defensive: only the fields
 * the renderer actually uses are extracted; any other sub-key is silently
 * dropped — a typo or future addition must not change behaviour. Returns
 * `undefined` when the sub-object is absent or not an object, so the
 * renderer can apply its defaults uniformly.
 */
function parseRender(raw: unknown): ProjectManifestRender | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const out: ProjectManifestRender = {};
  if (typeof record.enabled === 'boolean') out.enabled = record.enabled;
  if (typeof record.path === 'string') out.path = record.path;
  if (Array.isArray(record.names) && record.names.every((n) => typeof n === 'string')) {
    out.names = [...(record.names as string[])];
  }
  return out;
}

/** Loads the committed project manifest `.enigma.json`; unknown keys ignored; missing file yields defaults. Corrupt JSON raises `E_CONFIG_CORRUPT` (Issue #18) rather than a raw `SyntaxError`. The `render` sub-key is parsed into `manifest.render`; unknown sub-keys inside `render` are ignored. */
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
  const render = parseRender(raw.render);
  if (render) manifest.render = render;
  return manifest;
}