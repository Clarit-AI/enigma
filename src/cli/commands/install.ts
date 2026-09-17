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

/**
 * The on-disk formatting of an existing settings.json, reproduced on write so `--uninstall`
 * restores the original bytes instead of just JSON-equivalent content (a hand-formatted or
 * version-controlled settings.json shouldn't get its whole file reformatted by this command).
 *
 * **Preserved**: the indent unit (tabs vs spaces, and how many), whether the file ends in a
 * newline, and the line ending (LF vs CRLF).
 *
 * **Not preserved**: a minified (single-line) file — it has no indentation to detect, so it falls
 * back to the default below rather than staying minified; and internally inconsistent indentation
 * (e.g. 2 spaces at one depth, 4 at another) — normalized to whichever indent is seen first,
 * because `JSON.stringify`'s indent argument is one fixed string applied at every depth, so no
 * amount of detection here can reproduce a file that mixes indent widths.
 */
interface SettingsStyle {
  indent: string;
  trailingNewline: boolean;
  eol: '\n' | '\r\n';
}

/** Used only when creating a settings.json that didn't exist before — there is no prior style to preserve. */
const DEFAULT_STYLE: SettingsStyle = { indent: '  ', trailingNewline: true, eol: '\n' };

/** Detects indent width/character from the first indented line, whether the file ended in a
 * newline, and its line ending. See `SettingsStyle` for exactly what is and isn't preserved. */
function detectStyle(raw: string): SettingsStyle {
  const indentMatch = raw.match(/\n([ \t]+)\S/);
  return {
    indent: indentMatch?.[1] ?? DEFAULT_STYLE.indent,
    trailingNewline: raw.endsWith('\n'),
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
  };
}

function readSettings(path: string): { settings: ClaudeSettings; style: SettingsStyle } {
  if (!existsSync(path)) return { settings: {}, style: DEFAULT_STYLE };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new EnigmaError({
      code: 'E_CLAUDE_SETTINGS_UNWRITABLE',
      message: `Could not read ${path}: ${errorReason(err)}. Fix its permissions, then run enigma install again.`,
    });
  }
  if (raw.trim() === '') return { settings: {}, style: DEFAULT_STYLE };

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
  return { settings: parsed as ClaudeSettings, style: detectStyle(raw) };
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

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Writes minimally: only `enabledPlugins`/`extraKnownMarketplaces` are touched (see `cmdInstall`),
 * and this function's own job is to reproduce the original file's formatting exactly rather than
 * reformat the whole thing (`style`, from `detectStyle`). A directory-creation failure and a
 * file-write failure are reported separately — they're different problems for the user to fix,
 * and collapsing them into one message would point at the wrong path. */
function writeSettingsAtomic(path: string, settings: ClaudeSettings, style: SettingsStyle): void {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new EnigmaError({
      code: 'E_CLAUDE_SETTINGS_UNWRITABLE',
      message: `Could not create or access the settings directory ${dir}: ${errorReason(err)}. Fix its permissions, then run enigma install again.`,
    });
  }

  const tmpPath = `${path}.enigma-install-${process.pid}.tmp`;
  // JSON.stringify only ever emits bare `\n` between elements — never inside a string value,
  // where a literal newline is always the two-character escape `\n` — so this replace can't
  // accidentally touch data, only the structural newlines this function itself is producing.
  const lfBody = JSON.stringify(settings, null, style.indent);
  const body = style.eol === '\r\n' ? lfBody.replace(/\n/g, '\r\n') : lfBody;
  try {
    writeFileSync(tmpPath, style.trailingNewline ? `${body}${style.eol}` : body, 'utf8');
    renameSync(tmpPath, path);
  } catch (err) {
    throw new EnigmaError({
      code: 'E_CLAUDE_SETTINGS_UNWRITABLE',
      message: `Could not write ${path}: ${errorReason(err)}. Fix its permissions, then run enigma install again.`,
    });
  }
}

export async function cmdInstall(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, { boolean: ['uninstall'] });
  const uninstall = Boolean(flags.uninstall);
  const path = claudeSettingsPath();
  const { settings: before, style } = readSettings(path);

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

    writeSettingsAtomic(path, next, style);
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

  writeSettingsAtomic(path, next, style);
  process.stdout.write(
    `Registered the ${MARKETPLACE_NAME} marketplace (${REPO}) and enabled ${PLUGIN_ENTRY} in ${path}.\nRestart Claude Code to pick up the change.\n`,
  );
  return 0;
}
