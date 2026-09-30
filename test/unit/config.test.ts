import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, loadProjectManifest } from '../../src/core/config.js';
import { configPath } from '../../src/core/paths.js';
import { EnigmaError } from '../../src/core/errors.js';

describe('loadConfig', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns defaults when config.json is missing', () => {
    expect(loadConfig()).toEqual({});
  });

  it('loads known keys and ignores unknown ones', () => {
    writeFileSync(configPath(), JSON.stringify({ defaultDepository: 'encrypted', ui: 'web', bogusKey: 'x' }));
    expect(loadConfig()).toEqual({ defaultDepository: 'encrypted', ui: 'web' });
  });

  it('ignores an invalid enum value', () => {
    writeFileSync(configPath(), JSON.stringify({ ui: 'not-a-real-ui' }));
    expect(loadConfig()).toEqual({});
  });

  it('a corrupt config.json throws EnigmaError E_CONFIG_CORRUPT naming the path, never a raw SyntaxError (Issue #18)', () => {
    const CORRUPT_MARKER = 'totally-broken-bytes-should-never-appear-in-the-message';
    writeFileSync(configPath(), `{ ${CORRUPT_MARKER}`);

    try {
      loadConfig();
      expect.unreachable('loadConfig should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      const enigmaErr = err as EnigmaError;
      expect(enigmaErr.code).toBe('E_CONFIG_CORRUPT');
      expect(enigmaErr.message).toContain(configPath());
      expect(enigmaErr.message).not.toContain(CORRUPT_MARKER);
    }
  });
});

describe('loadProjectManifest', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('returns defaults when .enigma.json is missing', () => {
    expect(loadProjectManifest(tmpProject)).toEqual({ secrets: {} });
  });

  it('loads secrets map and ignores unknown top-level keys', () => {
    writeFileSync(
      join(tmpProject, '.enigma.json'),
      JSON.stringify({ defaultDepository: 'env', secrets: { OPENAI_API_KEY: 'OpenAI key' }, bogus: true }),
    );
    expect(loadProjectManifest(tmpProject)).toEqual({ defaultDepository: 'env', secrets: { OPENAI_API_KEY: 'OpenAI key' } });
  });

  describe('render key (Issue #107)', () => {
    const load = (render: unknown) => {
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ secrets: { A: 'a' }, render }));
      return loadProjectManifest(tmpProject);
    };

    it('a well-typed render key is parsed and unknown sub-keys are ignored', () => {
      expect(load({ enabled: false, path: 'config/local.env', names: ['A'], future: 1 })).toEqual({
        secrets: { A: 'a' },
        render: { enabled: false, path: 'config/local.env', names: ['A'] },
      });
    });

    it('[r1.9] a wrong-typed render value is reported in renderError (names the key, never the value) and render is omitted', () => {
      const manifest = load({ enabled: 'false' });
      expect(manifest.renderError).toBe('render.enabled must be a boolean');
      expect(manifest.render).toBeUndefined();
      expect(manifest.secrets).toEqual({ A: 'a' });
      expect(JSON.stringify(manifest)).not.toContain('"false"');
    });

    it.each([
      [{ enabled: 1 }, 'render.enabled must be a boolean'],
      [{ path: 5 }, 'render.path must be a string'],
      [{ names: 'A' }, 'render.names must be an array of strings'],
      [{ names: ['A', 2] }, 'render.names must be an array of strings'],
      [[], 'render must be an object'],
      ['x', 'render must be an object'],
      [null, 'render must be an object'],
    ])('[r1.9] render %j → renderError %s, and loadProjectManifest does not throw', (render, message) => {
      expect(load(render).renderError).toBe(message);
    });

    it('an absent or empty render key carries no error and no render', () => {
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ secrets: {} }));
      expect(loadProjectManifest(tmpProject)).toEqual({ secrets: {} });
      expect(load({})).toEqual({ secrets: { A: 'a' } });
    });
  });

  it('a corrupt .enigma.json throws EnigmaError E_CONFIG_CORRUPT naming the path, never a raw SyntaxError (Issue #18)', () => {
    const CORRUPT_MARKER = 'totally-broken-bytes-should-never-appear-in-the-message';
    writeFileSync(join(tmpProject, '.enigma.json'), `{ ${CORRUPT_MARKER}`);

    try {
      loadProjectManifest(tmpProject);
      expect.unreachable('loadProjectManifest should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      const enigmaErr = err as EnigmaError;
      expect(enigmaErr.code).toBe('E_CONFIG_CORRUPT');
      expect(enigmaErr.message).toContain(join(tmpProject, '.enigma.json'));
      expect(enigmaErr.message).not.toContain(CORRUPT_MARKER);
    }
  });
});
