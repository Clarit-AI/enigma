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
  /**
   * Item 9 (fix batch r1): when the `render` sub-object is present but
   * has the wrong shape (e.g. `enabled: "false"` instead of `false`),
   * `loadProjectManifest` carries a static, value-free message here and
   * OMITS `render` entirely. Other commands (`list`, `set`, etc.) ignore
   * this field; only the render path surfaces the error and exits 1.
   * The renderer NEVER has to throw from a bad manifest to keep
   * `loadProjectManifest` from breaking the other commands.
   */
  renderError?: string;
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
 * Parse the `render` sub-object (Issue #107). Item 9: when the sub-object
 * is present but any of its typed fields has the wrong shape, this
 * returns a `{ configError: string }` describing the first bad key —
 * values never. `loadProjectManifest` propagates that into the
 * returned manifest; the render path is the only consumer.
 *
 * Unknown sub-keys are silently ignored at parse time so a future
 * sub-key never silently activates.
 */
function parseRender(raw: unknown):
  | { ok: true; value: ProjectManifestRender }
  | { ok: false; configError: string } {
  if (raw === undefined) return { ok: true, value: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, configError: 'render must be an object' };
  }
  const record = raw as Record<string, unknown>;
  const out: ProjectManifestRender = {};
  if ('enabled' in record) {
    if (typeof record.enabled !== 'boolean') {
      return { ok: false, configError: 'render.enabled must be a boolean' };
    }
    out.enabled = record.enabled;
  }
  if ('path' in record) {
    if (typeof record.path !== 'string') {
      return { ok: false, configError: 'render.path must be a string' };
    }
    out.path = record.path;
  }
  if ('names' in record) {
    if (!Array.isArray(record.names) || !record.names.every((n) => typeof n === 'string')) {
      return { ok: false, configError: 'render.names must be an array of strings' };
    }
    out.names = [...(record.names as string[])];
  }
  return { ok: true, value: out };
}

/**
 * Loads the committed project manifest `.enigma.json`; unknown keys
 * ignored; missing file yields defaults. Corrupt JSON raises
 * `E_CONFIG_CORRUPT` (Issue #18) rather than a raw `SyntaxError`.
 *
 * The `render` sub-key is parsed into `manifest.render`; on a type
 * error, `manifest.renderError` is set to a static, names-only message
 * and `manifest.render` is omitted. Other commands (`list`, `set`,
 * etc.) never see the error and continue working — only the render
 * path reads `renderError`.
 */
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
  if ('render' in raw) {
    const parsed = parseRender(raw.render);
    if (parsed.ok) {
      if (Object.keys(parsed.value).length > 0) manifest.render = parsed.value;
    } else {
      manifest.renderError = parsed.configError;
    }
  }
  return manifest;
}
