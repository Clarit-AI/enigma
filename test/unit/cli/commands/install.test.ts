import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdInstall, claudeSettingsPath } from '../../../../src/cli/commands/install.js';
import { EnigmaError } from '../../../../src/core/errors.js';

const MARKETPLACE = 'clarit-enigma';
const PLUGIN_ENTRY = 'enigma@clarit-enigma';

describe('cmdInstall', () => {
  let tmpConfigDir: string;
  let originalConfigDir: string | undefined;
  let settingsPath: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'enigma-claude-config-'));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
    settingsPath = claudeSettingsPath();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function readSettingsFile(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  }

  it('resolves the settings path under CLAUDE_CONFIG_DIR', () => {
    expect(settingsPath).toBe(join(tmpConfigDir, 'settings.json'));
  });

  it('creates settings.json when none exists, registering the marketplace and enabling the plugin', async () => {
    expect(existsSync(settingsPath)).toBe(false);

    const code = await cmdInstall([]);

    expect(code).toBe(0);
    const settings = readSettingsFile();
    expect(settings.enabledPlugins).toEqual({ [PLUGIN_ENTRY]: true });
    expect(settings.extraKnownMarketplaces).toEqual({
      [MARKETPLACE]: { source: { source: 'github', repo: 'Clarit-AI/enigma' } },
    });
  });

  it('preserves unrelated existing keys and existing plugins/marketplaces', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        enabledPlugins: { 'other-plugin@other-marketplace': true },
        extraKnownMarketplaces: { 'other-marketplace': { source: { source: 'github', repo: 'someone/else' } } },
      }),
    );

    const code = await cmdInstall([]);

    expect(code).toBe(0);
    const settings = readSettingsFile();
    expect(settings.theme).toBe('dark');
    expect(settings.enabledPlugins).toEqual({
      'other-plugin@other-marketplace': true,
      [PLUGIN_ENTRY]: true,
    });
    expect(settings.extraKnownMarketplaces).toEqual({
      'other-marketplace': { source: { source: 'github', repo: 'someone/else' } },
      [MARKETPLACE]: { source: { source: 'github', repo: 'Clarit-AI/enigma' } },
    });
  });

  it('is idempotent: running install twice does not duplicate or change anything on the second run', async () => {
    await cmdInstall([]);
    const firstRun = readFileSync(settingsPath, 'utf8');

    const code = await cmdInstall([]);

    expect(code).toBe(0);
    expect(readFileSync(settingsPath, 'utf8')).toBe(firstRun);
    expect(stdoutSpy.mock.calls.at(-1)?.[0]).toContain('already registered');
  });

  it('--uninstall reverses install, restoring settings.json to its prior shape', async () => {
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));

    await cmdInstall([]);
    const code = await cmdInstall(['--uninstall']);

    expect(code).toBe(0);
    const settings = readSettingsFile();
    expect(settings).toEqual({ theme: 'dark' });
  });

  it('--uninstall only removes the marketplace entry it owns, leaving other keys alone', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        enabledPlugins: { 'other-plugin@other-marketplace': true },
        extraKnownMarketplaces: { 'other-marketplace': { source: { source: 'github', repo: 'someone/else' } } },
      }),
    );
    await cmdInstall([]);

    const code = await cmdInstall(['--uninstall']);

    expect(code).toBe(0);
    const settings = readSettingsFile();
    expect(settings.enabledPlugins).toEqual({ 'other-plugin@other-marketplace': true });
    expect(settings.extraKnownMarketplaces).toEqual({
      'other-marketplace': { source: { source: 'github', repo: 'someone/else' } },
    });
  });

  it('--uninstall is idempotent when nothing is installed', async () => {
    const code = await cmdInstall(['--uninstall']);

    expect(code).toBe(0);
    expect(existsSync(settingsPath)).toBe(false);
    expect(stdoutSpy.mock.calls.at(-1)?.[0]).toContain('not registered');
  });

  it('treats an existing empty settings.json the same as a missing one', async () => {
    writeFileSync(settingsPath, '');

    const code = await cmdInstall([]);

    expect(code).toBe(0);
    expect(readSettingsFile().enabledPlugins).toEqual({ [PLUGIN_ENTRY]: true });
  });

  it('rejects malformed JSON without rewriting the file', async () => {
    writeFileSync(settingsPath, '{ not valid json');

    await expect(cmdInstall([])).rejects.toThrow(EnigmaError);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ not valid json');
  });

  it('rejects a settings.json that is a JSON array', async () => {
    writeFileSync(settingsPath, '[]');

    await expect(cmdInstall([])).rejects.toThrow(EnigmaError);
  });

  it('refuses to overwrite a same-named marketplace entry pointing at a different repo', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ extraKnownMarketplaces: { [MARKETPLACE]: { source: { source: 'github', repo: 'someone/else' } } } }),
    );

    await expect(cmdInstall([])).rejects.toThrow(EnigmaError);
    const settings = readSettingsFile();
    expect(settings.extraKnownMarketplaces).toEqual({
      [MARKETPLACE]: { source: { source: 'github', repo: 'someone/else' } },
    });
  });

  it('re-enables the plugin if the user had manually disabled it', async () => {
    await cmdInstall([]);
    const settings = readSettingsFile();
    settings.enabledPlugins = { [PLUGIN_ENTRY]: false };
    writeFileSync(settingsPath, JSON.stringify(settings));

    const code = await cmdInstall([]);

    expect(code).toBe(0);
    expect(readSettingsFile().enabledPlugins).toEqual({ [PLUGIN_ENTRY]: true });
  });

  it('creates the config directory when it does not exist yet', async () => {
    rmSync(tmpConfigDir, { recursive: true, force: true });
    mkdirSync(join(tmpConfigDir, '..'), { recursive: true });

    const code = await cmdInstall([]);

    expect(code).toBe(0);
    expect(existsSync(settingsPath)).toBe(true);
  });
});
