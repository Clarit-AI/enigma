import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setSecret } from '../../src/storage/manager.js';
import { indexPath, auditLogPath, secretsPath } from '../../src/core/paths.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

describe('no secret value leaks into names-only state (D1.8)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
    mkdirSync(join(tmpProject, '.git'));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('index.json, audit.log, and secrets.enc never contain a sentinel value set through the public API', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'GITHUB_TOKEN', value: SENTINEL, scope: 'project', depository: 'env', cwd: tmpProject, actor: 'cli' });

    for (const path of [indexPath(), auditLogPath(), secretsPath()]) {
      expect(readFileSync(path, 'utf8')).not.toContain(SENTINEL);
    }
  });
});
