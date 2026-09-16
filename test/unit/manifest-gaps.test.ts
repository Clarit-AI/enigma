import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeManifestGaps } from '../../src/core/manifest-gaps.js';
import { setSecret } from '../../src/storage/manager.js';

describe('computeManifestGaps', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('returns no gaps when .enigma.json is absent', () => {
    expect(computeManifestGaps(tmpProject)).toEqual({ registeredNames: [], gaps: [] });
  });

  it('reports exactly the declared names with no stored value, sorted', async () => {
    writeFileSync(
      join(tmpProject, '.enigma.json'),
      JSON.stringify({ secrets: { OPENAI_API_KEY: 'x', GITHUB_TOKEN: 'y', REGISTERED: 'z' } }),
    );
    await setSecret({ name: 'REGISTERED', value: 'v', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const result = computeManifestGaps(tmpProject);
    expect(result.gaps).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    expect(result.registeredNames).toEqual(['REGISTERED']);
  });

  it('a global entry satisfies a project manifest gap', async () => {
    writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ secrets: { OPENAI_API_KEY: 'x' } }));
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });

    expect(computeManifestGaps(tmpProject).gaps).toEqual([]);
  });

  it('a same-named secret registered in an UNRELATED project never masks a genuine gap here (Issue #13 review B2)', async () => {
    const otherProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-other-project-')));
    mkdirSync(join(otherProject, '.git'));
    try {
      await setSecret({ name: 'API_KEY', value: 'v', scope: 'project', depository: 'encrypted', cwd: otherProject, actor: 'cli' });
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ secrets: { API_KEY: 'this project needs its own' } }));

      expect(computeManifestGaps(tmpProject).gaps).toEqual(['API_KEY']);
      expect(computeManifestGaps(tmpProject).registeredNames).toEqual([]);
    } finally {
      rmSync(otherProject, { recursive: true, force: true });
    }
  });
});
