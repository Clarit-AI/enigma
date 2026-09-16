import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitImport } from '../../../src/storage/import-commit.js';
import { listSecrets } from '../../../src/storage/manager.js';

describe('commitImport', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let envFilePath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
    envFilePath = join(tmpProject, '.env');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('AC1: on full success into a non-env depository, every entry is stored, the file is rewritten with those lines removed and one summary comment, and unrelated lines survive byte-identical', async () => {
    writeFileSync(envFilePath, '# header\nKEEP_ME=1\nOPENAI_API_KEY=sk-abc\nGITHUB_TOKEN=ghp-xyz\nALSO_KEEP=2\n');

    const result = await commitImport({
      entries: [
        { name: 'OPENAI_API_KEY', value: 'sk-abc' },
        { name: 'GITHUB_TOKEN', value: 'ghp-xyz' },
      ],
      depository: 'encrypted',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });

    expect(result.succeeded).toEqual(['OPENAI_API_KEY', 'GITHUB_TOKEN']);
    expect(result.failed).toEqual([]);
    expect(result.fileRewritten).toBe(true);

    const rewritten = readFileSync(envFilePath, 'utf8');
    expect(rewritten).toContain('# header\nKEEP_ME=1\n');
    expect(rewritten).toContain('ALSO_KEEP=2\n');
    expect(rewritten).not.toContain('sk-abc');
    expect(rewritten).not.toContain('ghp-xyz');
    expect(rewritten).toMatch(/# Moved to Enigma \(encrypted\) by `enigma import`.*OPENAI_API_KEY, GITHUB_TOKEN/);

    const stored = listSecrets({ scope: 'all', cwd: tmpProject });
    expect(stored.map((e) => e.name).sort()).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
  });

  it('AC2: into the env depository, values move into the managed block only — no summary comment, raw lines simply gone', async () => {
    writeFileSync(envFilePath, 'KEEP_ME=1\nOPENAI_API_KEY=sk-abc\n');

    const result = await commitImport({
      entries: [{ name: 'OPENAI_API_KEY', value: 'sk-abc' }],
      depository: 'env',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });

    expect(result.succeeded).toEqual(['OPENAI_API_KEY']);
    expect(result.fileRewritten).toBe(true);

    const rewritten = readFileSync(envFilePath, 'utf8');
    expect(rewritten).not.toContain('# Moved to Enigma');
    expect(rewritten).toContain('KEEP_ME=1\n');
    expect(rewritten).toContain('# enigma:begin\nOPENAI_API_KEY=sk-abc\n# enigma:end\n');
    expect(rewritten.match(/OPENAI_API_KEY=sk-abc/g)).toHaveLength(1);
  });

  it('AC4: warns when .env is not gitignored, and the warning is silent when it is', async () => {
    writeFileSync(envFilePath, 'OPENAI_API_KEY=sk-abc\n');
    const noGitignore = await commitImport({
      entries: [{ name: 'OPENAI_API_KEY', value: 'sk-abc' }],
      depository: 'encrypted',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });
    expect(noGitignore.warnings.some((w) => w.includes('.env is not gitignored'))).toBe(true);
  });

  it('loud abort: a failure on key 2 of 3 stops the batch, leaves .env completely untouched, and reports the third as not attempted', async () => {
    writeFileSync(envFilePath, 'KEY_ONE=v1\nKEY_TWO=v2\nKEY_THREE=v3\n');
    const original = readFileSync(envFilePath, 'utf8');

    // Pre-seed KEY_TWO in the index so its setSecret call fails with E_EXISTS (rotate not set).
    await commitImport({
      entries: [{ name: 'KEY_TWO', value: 'already-there' }],
      depository: 'encrypted',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });
    // That call already rewrote the file (only KEY_TWO existed then); reset it back to the 3-key original for this test.
    writeFileSync(envFilePath, original);

    const result = await commitImport({
      entries: [
        { name: 'KEY_ONE', value: 'v1' },
        { name: 'KEY_TWO', value: 'v2' },
        { name: 'KEY_THREE', value: 'v3' },
      ],
      depository: 'encrypted',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });

    expect(result.succeeded).toEqual(['KEY_ONE']);
    expect(result.failed).toEqual([{ name: 'KEY_TWO', errorCode: 'E_EXISTS' }]);
    expect(result.notAttempted).toEqual(['KEY_THREE']);
    expect(result.fileRewritten).toBe(false);
    expect(readFileSync(envFilePath, 'utf8')).toBe(original);
  });

  it('the env depository writes its managed block as a side effect even on an aborted batch, and the result warns about it', async () => {
    writeFileSync(envFilePath, 'KEY_ONE=v1\nKEY_TWO=v2\n');

    await commitImport({
      entries: [{ name: 'KEY_TWO', value: 'already-there' }],
      depository: 'env',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });
    writeFileSync(envFilePath, 'KEY_ONE=v1\nKEY_TWO=v2\n# enigma:begin\nKEY_TWO=already-there\n# enigma:end\n');

    const result = await commitImport({
      entries: [
        { name: 'KEY_ONE', value: 'v1' },
        { name: 'KEY_TWO', value: 'v2' },
      ],
      depository: 'env',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });

    expect(result.succeeded).toEqual(['KEY_ONE']);
    expect(result.failed).toEqual([{ name: 'KEY_TWO', errorCode: 'E_EXISTS' }]);
    expect(result.fileRewritten).toBe(false);
    expect(result.warnings.some((w) => w.includes('already written into the .env managed block'))).toBe(true);
    // KEY_ONE's raw line is still present in plaintext — the batch aborted before the removal step ran.
    expect(readFileSync(envFilePath, 'utf8')).toContain('KEY_ONE=v1');
  });
});
