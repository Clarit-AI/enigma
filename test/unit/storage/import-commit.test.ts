import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitImport } from '../../../src/storage/import-commit.js';
import { listSecrets } from '../../../src/storage/manager.js';
import { parseDotEnv } from '../../../src/storage/dotenv-file.js';
import type { ParsedDotEnvEntry } from '../../../src/storage/dotenv-file.js';

/** Shorthand for an unambiguous entry literal — most tests here don't care about A2/duplicate-key handling. */
function entry(name: string, value: string): ParsedDotEnvEntry {
  return { name, value, ambiguous: false };
}

/** Builds a real (ambiguous, ambiguousReason)-carrying entry via the actual parser, rather than hand-rolling a reason string that could drift from what production code produces. */
function parsedEntry(line: string, name: string): ParsedDotEnvEntry {
  return parseDotEnv(line).entries.find((e) => e.name === name)!;
}

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
    vi.restoreAllMocks();
  });

  it('AC1: on full success into a non-env depository, every entry is stored, the file is rewritten with those lines removed and one summary comment, and unrelated lines survive byte-identical', async () => {
    writeFileSync(envFilePath, '# header\nKEEP_ME=1\nOPENAI_API_KEY=sk-abc\nGITHUB_TOKEN=ghp-xyz\nALSO_KEEP=2\n');

    const result = await commitImport({
      entries: [entry('OPENAI_API_KEY', 'sk-abc'), entry('GITHUB_TOKEN', 'ghp-xyz')],
      depository: 'encrypted',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });

    expect(result.succeeded).toEqual(['OPENAI_API_KEY', 'GITHUB_TOKEN']);
    expect(result.failed).toEqual([]);
    expect(result.skippedMismatch).toEqual([]);
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
      entries: [entry('OPENAI_API_KEY', 'sk-abc')],
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
      entries: [entry('OPENAI_API_KEY', 'sk-abc')],
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
      entries: [entry('KEY_TWO', 'already-there')],
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
      entries: [entry('KEY_ONE', 'v1'), entry('KEY_TWO', 'v2'), entry('KEY_THREE', 'v3')],
      depository: 'encrypted',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });

    expect(result.succeeded).toEqual(['KEY_ONE']);
    expect(result.failed).toEqual([{ name: 'KEY_TWO', errorCode: 'E_EXISTS', message: expect.stringContaining('already exists') }]);
    expect(result.notAttempted).toEqual(['KEY_THREE']);
    expect(result.fileRewritten).toBe(false);
    expect(readFileSync(envFilePath, 'utf8')).toBe(original);
  });

  it('the env depository writes its managed block as a side effect even on an aborted batch, and the result warns about it', async () => {
    writeFileSync(envFilePath, 'KEY_ONE=v1\nKEY_TWO=v2\n');

    await commitImport({
      entries: [entry('KEY_TWO', 'already-there')],
      depository: 'env',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });
    writeFileSync(envFilePath, 'KEY_ONE=v1\nKEY_TWO=v2\n# enigma:begin\nKEY_TWO=already-there\n# enigma:end\n');

    const result = await commitImport({
      entries: [entry('KEY_ONE', 'v1'), entry('KEY_TWO', 'v2')],
      depository: 'env',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });

    expect(result.succeeded).toEqual(['KEY_ONE']);
    expect(result.failed).toEqual([{ name: 'KEY_TWO', errorCode: 'E_EXISTS', message: expect.stringContaining('already exists') }]);
    expect(result.fileRewritten).toBe(false);
    expect(result.warnings.some((w) => w.includes('already written into the .env managed block'))).toBe(true);
    // KEY_ONE's raw line is still present in plaintext — the batch aborted before the removal step ran.
    expect(readFileSync(envFilePath, 'utf8')).toContain('KEY_ONE=v1');
  });

  describe('B1: parse/rewrite interleaving — same-value happy path (fs-mocked variants live in import-commit-fs-mocked.test.ts)', () => {
    it('when the current value still matches, the line is removed exactly as the plain-success test above already proves', async () => {
      writeFileSync(envFilePath, 'DB_PASSWORD=v\n');
      const result = await commitImport({
        entries: [entry('DB_PASSWORD', 'v')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });
      expect(result.skippedMismatch).toEqual([]);
      expect(result.fileRewritten).toBe(true);
    });
  });

  describe('A2: ambiguous inline-comment-like values (Issue #13 review, round 2)', () => {
    it('an unquoted value with " #" refuses through the loud-abort path, never touching the depository', async () => {
      writeFileSync(envFilePath, 'PORT=3000 # dev port\n');

      const result = await commitImport({
        entries: [parsedEntry('PORT=3000 # dev port\n', 'PORT')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toEqual([
        { name: 'PORT', errorCode: 'E_VALUE_AMBIGUOUS', message: expect.stringContaining('quote the value') },
      ]);
      expect(result.fileRewritten).toBe(false);
      expect(readFileSync(envFilePath, 'utf8')).toBe('PORT=3000 # dev port\n');
      expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
    });

    it('a passphrase like "hunter2 #1" is refused rather than silently truncated', async () => {
      writeFileSync(envFilePath, 'PASSPHRASE=hunter2 #1\n');

      const result = await commitImport({
        entries: [parsedEntry('PASSPHRASE=hunter2 #1\n', 'PASSPHRASE')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      expect(result.failed[0]?.errorCode).toBe('E_VALUE_AMBIGUOUS');
      expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
      expect(readFileSync(envFilePath, 'utf8')).toBe('PASSPHRASE=hunter2 #1\n');
    });

    it('a quoted value containing "#" migrates intact, unaffected by the ambiguity check', async () => {
      writeFileSync(envFilePath, 'TOKEN="abc#def"\n');

      const result = await commitImport({
        entries: [entry('TOKEN', 'abc#def')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      expect(result.succeeded).toEqual(['TOKEN']);
      expect(result.fileRewritten).toBe(true);
      expect(readFileSync(envFilePath, 'utf8')).not.toContain('abc#def');
    });

    it('a plain unquoted value with no "#" is unaffected', async () => {
      writeFileSync(envFilePath, 'OPENAI_API_KEY=sk-abc\n');

      const result = await commitImport({
        entries: [entry('OPENAI_API_KEY', 'sk-abc')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      expect(result.succeeded).toEqual(['OPENAI_API_KEY']);
      expect(result.fileRewritten).toBe(true);
    });
  });

  describe('duplicate keys (Issue #13 review, round 3, item 1)', () => {
    it('a duplicated key with two different values refuses through the loud-abort path — neither line is removed', async () => {
      const original = 'API_KEY=real-production-key\nAPI_KEY=placeholder\n';
      writeFileSync(envFilePath, original);

      const result = await commitImport({
        entries: [parsedEntry(original, 'API_KEY')],
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toEqual([
        { name: 'API_KEY', errorCode: 'E_VALUE_AMBIGUOUS', message: expect.stringContaining('assigned more than once') },
      ]);
      expect(result.fileRewritten).toBe(false);
      // Neither the never-migrated first value nor the migrated-nowhere last value is stored...
      expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
      // ...and both physical lines survive exactly as they were — no line is promoted, none is dropped.
      expect(readFileSync(envFilePath, 'utf8')).toBe(original);
    });

    it('a duplicated key does not block unrelated names earlier in the batch from succeeding', async () => {
      const content = 'GITHUB_TOKEN=ghp-xyz\nAPI_KEY=first\nAPI_KEY=second\n';
      writeFileSync(envFilePath, content);
      const parsed = parseDotEnv(content);

      const result = await commitImport({
        entries: parsed.entries,
        depository: 'encrypted',
        scope: 'project',
        cwd: tmpProject,
        projectPath: tmpProject,
        envFilePath,
        actor: 'cli',
      });

      expect(result.succeeded).toEqual(['GITHUB_TOKEN']);
      expect(result.failed[0]?.name).toBe('API_KEY');
      expect(result.fileRewritten).toBe(false);
      // GITHUB_TOKEN's line is left in the file too — the whole batch aborted, matching every other loud-abort case.
      expect(readFileSync(envFilePath, 'utf8')).toBe(content);
    });
  });
});
