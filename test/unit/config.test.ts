import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, loadProjectManifest } from '../../src/core/config.js';
import { configPath } from '../../src/core/paths.js';

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
});
