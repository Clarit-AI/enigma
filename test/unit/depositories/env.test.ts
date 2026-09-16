import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEnvGitignore, envDepositoryModule } from '../../../src/storage/depositories/env.js';
import { EnigmaError } from '../../../src/core/errors.js';

const nodeUtil = await import('node:util');
const parseEnv: ((raw: string) => Record<string, string | undefined>) | undefined =
  typeof nodeUtil.parseEnv === 'function' ? nodeUtil.parseEnv : undefined;

const SENTINEL = 'sk-sentinel-value-should-never-appear';

describe('env depository', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('reports available without prompting', async () => {
    await expect(envDepositoryModule.detect()).resolves.toEqual({ id: 'env', promptProfile: 'none', available: true });
  });

  it('throws E_DEPOSITORY_UNAVAILABLE when created without a project path', () => {
    expect(() => envDepositoryModule.create({})).toThrowError(expect.objectContaining({ code: 'E_DEPOSITORY_UNAVAILABLE' }));
  });

  it('creates a new .env with the managed block when none exists', async () => {
    const depo = envDepositoryModule.create({ projectPath: tmpProject });
    await depo.set('OPENAI_API_KEY', SENTINEL);

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toBe(`# enigma:begin\nOPENAI_API_KEY=${SENTINEL}\n# enigma:end\n`);
  });

  it('appends the block after existing content, adding a newline first if missing', async () => {
    writeFileSync(join(tmpProject, '.env'), 'EXISTING=untouched');
    const depo = envDepositoryModule.create({ projectPath: tmpProject });
    await depo.set('OPENAI_API_KEY', SENTINEL);

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toBe(`EXISTING=untouched\n# enigma:begin\nOPENAI_API_KEY=${SENTINEL}\n# enigma:end\n`);
  });

  it('updates an existing NAME inside the block without disturbing other lines', async () => {
    writeFileSync(
      join(tmpProject, '.env'),
      'BEFORE=kept\n# enigma:begin\nOPENAI_API_KEY=old-value\n# enigma:end\nAFTER=also-kept\n',
    );
    const depo = envDepositoryModule.create({ projectPath: tmpProject });
    await depo.set('OPENAI_API_KEY', SENTINEL);

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toBe(`BEFORE=kept\n# enigma:begin\nOPENAI_API_KEY=${SENTINEL}\n# enigma:end\nAFTER=also-kept\n`);
  });

  it('preserves CRLF line endings byte-for-byte outside and inside the block', async () => {
    writeFileSync(join(tmpProject, '.env'), 'BEFORE=kept\r\n# enigma:begin\r\nOPENAI_API_KEY=old-value\r\n# enigma:end\r\n');
    const depo = envDepositoryModule.create({ projectPath: tmpProject });
    await depo.set('OPENAI_API_KEY', SENTINEL);

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toBe(`BEFORE=kept\r\n# enigma:begin\r\nOPENAI_API_KEY=${SENTINEL}\r\n# enigma:end\r\n`);
  });

  it('adds a second NAME to an existing block in insertion order', async () => {
    const depo = envDepositoryModule.create({ projectPath: tmpProject });
    await depo.set('FIRST', 'a');
    await depo.set('SECOND', 'b');

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toBe('# enigma:begin\nFIRST=a\nSECOND=b\n# enigma:end\n');
  });

  it('resolve/has read a value back out of the managed block', async () => {
    const depo = envDepositoryModule.create({ projectPath: tmpProject });
    await depo.set('OPENAI_API_KEY', SENTINEL);

    await expect(depo.resolve('OPENAI_API_KEY')).resolves.toBe(SENTINEL);
    await expect(depo.has('OPENAI_API_KEY')).resolves.toBe(true);
  });

  it('resolve throws E_NOT_FOUND for an unmanaged name', async () => {
    const depo = envDepositoryModule.create({ projectPath: tmpProject });
    await expect(depo.resolve('MISSING')).rejects.toThrow(EnigmaError);
    await expect(depo.has('MISSING')).resolves.toBe(false);
  });

  it('delete removes only the targeted NAME from the block', async () => {
    const depo = envDepositoryModule.create({ projectPath: tmpProject });
    await depo.set('FIRST', 'a');
    await depo.set('SECOND', 'b');
    await depo.delete('FIRST');

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toBe('# enigma:begin\nSECOND=b\n# enigma:end\n');
  });

  it('set resolves to the input ref unchanged (B3)', async () => {
    const depo = envDepositoryModule.create({ projectPath: tmpProject });
    await expect(depo.set('OPENAI_API_KEY', SENTINEL)).resolves.toBe('OPENAI_API_KEY');
  });

  describe('dotenv-compatible quoting (B2)', () => {
    it('writes a bare value with no special characters unquoted', async () => {
      const depo = envDepositoryModule.create({ projectPath: tmpProject });
      await depo.set('PLAIN', 'abc123');

      const content = readFileSync(join(tmpProject, '.env'), 'utf8');
      expect(content).toBe('# enigma:begin\nPLAIN=abc123\n# enigma:end\n');
    });

    it('round-trips a PEM-style multi-line value, quoted with escaped newlines', async () => {
      const pem = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----\n';
      const depo = envDepositoryModule.create({ projectPath: tmpProject });
      await depo.set('PEM_KEY', pem);

      const content = readFileSync(join(tmpProject, '.env'), 'utf8');
      expect(content).toBe(
        '# enigma:begin\nPEM_KEY="-----BEGIN PRIVATE KEY-----\\nMIIBVQIBADANBgkqhkiG9w0\\n-----END PRIVATE KEY-----\\n"\n# enigma:end\n',
      );
      await expect(depo.resolve('PEM_KEY')).resolves.toBe(pem);

      if (parseEnv) {
        const parsed = parseEnv(content);
        expect(parsed.PEM_KEY).toBe(pem);
      }
    });

    it('round-trips a value containing backslashes and double quotes', async () => {
      const value = 'a\\path\\with "quotes" and \\ backslashes';
      const depo = envDepositoryModule.create({ projectPath: tmpProject });
      await depo.set('TRICKY', value);

      await expect(depo.resolve('TRICKY')).resolves.toBe(value);
    });

    it('a value containing "# enigma:end" is quoted and cannot terminate the block', async () => {
      const value = '# enigma:end';
      const depo = envDepositoryModule.create({ projectPath: tmpProject });
      await depo.set('SNEAKY', value);
      await depo.set('AFTER', 'still-inside-block');

      const content = readFileSync(join(tmpProject, '.env'), 'utf8');
      expect(content).toBe('# enigma:begin\nSNEAKY="# enigma:end"\nAFTER=still-inside-block\n# enigma:end\n');
      await expect(depo.resolve('SNEAKY')).resolves.toBe(value);
      await expect(depo.resolve('AFTER')).resolves.toBe('still-inside-block');
    });
  });
});

describe('checkEnvGitignore', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('warns when there is no .gitignore at all', () => {
    expect(checkEnvGitignore(tmpProject)).toHaveLength(1);
  });

  it('warns when .gitignore exists but does not cover .env', () => {
    writeFileSync(join(tmpProject, '.gitignore'), 'node_modules/\n');
    expect(checkEnvGitignore(tmpProject)).toHaveLength(1);
  });

  it('is silent when .gitignore covers .env literally', () => {
    writeFileSync(join(tmpProject, '.gitignore'), '.env\n.env.*\n!.env.example\n');
    expect(checkEnvGitignore(tmpProject)).toEqual([]);
  });

  it('is silent when .gitignore covers .env via a wildcard pattern', () => {
    writeFileSync(join(tmpProject, '.gitignore'), '.env*\n');
    expect(checkEnvGitignore(tmpProject)).toEqual([]);
  });
});
