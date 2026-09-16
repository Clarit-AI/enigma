import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from '../args.js';
import { EnigmaError } from '../../core/errors.js';

const MARKETPLACE_NAME = 'clarit-enigma';
const REPO = 'Clarit-AI/enigma';
const PLUGIN_ENTRY = `enigma@${MARKETPLACE_NAME}`;

interface MarketplaceSource {
  source?: { source?: string; repo?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** The subset of Claude Code's user `settings.json` this command reads and writes; every other key is passed through untouched. */
interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: Record<string, MarketplaceSource>;
  [key: string]: unknown;
}

/** `CLAUDE_CONFIG_DIR` is the real CLI's own override for its config home (defaults to `~/.claude`); honoring it here keeps `enigma install` in sync with wherever the user's Claude Code actually reads settings from. */
export function claudeSettingsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, 'settings.json');
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EnigmaError({
      code: 'E_CLAUDE_SETTINGS_INVALID',
      message: `${path} is not valid JSON. Fix or remove it by hand, then run enigma install again.`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnigmaError({
      code: 'E_CLAUDE_SETTINGS_INVALID',
      message: `${path} must contain a JSON object. Fix or remove it by hand, then run enigma install again.`,
    });
  }
  return parsed as ClaudeSettings;
}

/** Rejects a `settings.json` where `key` already exists but isn't a plain object — writing through it would silently discard whatever the user had there. */
function expectRecord(settings: ClaudeSettings, key: 'enabledPlugins' | 'extraKnownMarketplaces', path: string): Record<string, unknown> {
  const value = settings[key];
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EnigmaError({
      code: 'E_CLAUDE_SETTINGS_INVALID',
      message: `${path}'s "${key}" must be a JSON object; it is not. Fix it by hand, then run enigma install again.`,
    });
  }
  return value as Record<string, unknown>;
}

function isEnigmaMarketplaceSource(entry: MarketplaceSource | undefined): boolean {
  return entry?.source?.source === 'github' && entry.source?.repo === REPO;
}

function writeSettingsAtomic(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.enigma-install-${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, path);
}

export async function cmdInstall(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, { boolean: ['uninstall'] });
  const uninstall = Boolean(flags.uninstall);
  const path = claudeSettingsPath();
  const before = readSettings(path);

  const enabledPlugins = expectRecord(before, 'enabledPlugins', path) as Record<string, boolean>;
  const marketplaces = expectRecord(before, 'extraKnownMarketplaces', path) as Record<string, MarketplaceSource>;
  const marketplaceEntry = marketplaces[MARKETPLACE_NAME];

  if (uninstall) {
    const isEnabled = enabledPlugins[PLUGIN_ENTRY] === true;
    const hasOwnMarketplace = marketplaceEntry !== undefined && isEnigmaMarketplaceSource(marketplaceEntry);
    if (!isEnabled && !hasOwnMarketplace) {
      process.stdout.write(`Enigma is not registered in ${path}; nothing to do.\n`);
      return 0;
    }

    const nextEnabled = { ...enabledPlugins };
    delete nextEnabled[PLUGIN_ENTRY];
    const nextMarketplaces = { ...marketplaces };
    // Only remove the marketplace entry if it's still the one enigma install
    // created — a same-named entry pointing elsewhere isn't ours to delete.
    if (hasOwnMarketplace) delete nextMarketplaces[MARKETPLACE_NAME];

    const next: ClaudeSettings = { ...before };
    if (Object.keys(nextEnabled).length > 0) next.enabledPlugins = nextEnabled;
    else delete next.enabledPlugins;
    if (Object.keys(nextMarketplaces).length > 0) next.extraKnownMarketplaces = nextMarketplaces;
    else delete next.extraKnownMarketplaces;

    writeSettingsAtomic(path, next);
    process.stdout.write(`Disabled ${PLUGIN_ENTRY} and unregistered the ${MARKETPLACE_NAME} marketplace in ${path}.\n`);
    return 0;
  }

  if (marketplaceEntry !== undefined && !isEnigmaMarketplaceSource(marketplaceEntry)) {
    throw new EnigmaError({
      code: 'E_CLAUDE_SETTINGS_INVALID',
      message: `${path}'s "extraKnownMarketplaces.${MARKETPLACE_NAME}" already points somewhere other than ${REPO}. Resolve that by hand, then run enigma install again.`,
    });
  }

  const alreadyInstalled = enabledPlugins[PLUGIN_ENTRY] === true && isEnigmaMarketplaceSource(marketplaceEntry);
  if (alreadyInstalled) {
    process.stdout.write(`Enigma is already registered in ${path}; nothing to do.\n`);
    return 0;
  }

  const next: ClaudeSettings = {
    ...before,
    extraKnownMarketplaces: { ...marketplaces, [MARKETPLACE_NAME]: { source: { source: 'github', repo: REPO } } },
    enabledPlugins: { ...enabledPlugins, [PLUGIN_ENTRY]: true },
  };

  writeSettingsAtomic(path, next);
  process.stdout.write(
    `Registered the ${MARKETPLACE_NAME} marketplace (${REPO}) and enabled ${PLUGIN_ENTRY} in ${path}.\nRestart Claude Code to pick up the change.\n`,
  );
  return 0;
}
