import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteSecret, hasSecret, listSecrets, resolveSecret, setSecret } from '../../src/storage/manager.js';
import { EnigmaError } from '../../src/core/errors.js';
import { auditLogPath } from '../../src/core/paths.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

describe('storage manager', () => {
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

  it('sets and resolves a global secret through the encrypted depository', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('sets a project secret through env and records projectPath in clear', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'env', cwd: tmpProject, actor: 'cli' });

    const [entry] = listSecrets({ scope: 'project', cwd: tmpProject });
    expect(entry?.projectPath).toBe(tmpProject);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: tmpProject, actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('env-backed secrets record the bare NAME as ref, and the .env managed block has no scope prefix (B1)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'env', cwd: tmpProject, actor: 'cli' });

    const [entry] = listSecrets({ scope: 'project', cwd: tmpProject });
    expect(entry?.ref).toBe('OPENAI_API_KEY');

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toBe(`# enigma:begin\nOPENAI_API_KEY=${SENTINEL}\n# enigma:end\n`);
  });

  it('setSecret rejects depository "env" with scope "global" with E_SCOPE_INVALID (A1)', async () => {
    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'env', actor: 'cli' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_SCOPE_INVALID' }));
  });

  it('set on an existing name without rotate throws E_EXISTS', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: 'new-value', scope: 'global', depository: 'encrypted', actor: 'cli' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_EXISTS' }));
  });

  it('set with rotate overwrites and reports rotated: true', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const result = await setSecret({
      name: 'OPENAI_API_KEY',
      value: 'rotated-value',
      scope: 'global',
      depository: 'encrypted',
      rotate: true,
      actor: 'cli',
    });

    expect(result.rotated).toBe(true);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'cli' })).resolves.toBe('rotated-value');
  });

  it('warns when setting an env secret whose project has no covering .gitignore', async () => {
    const result = await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'env', cwd: tmpProject, actor: 'cli' });
    expect(result.warnings).toHaveLength(1);
  });

  it('project entry shadows global in listSecrets and hasSecret without an explicit scope', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'global-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const views = listSecrets({ scope: 'all', cwd: tmpProject });
    const globalView = views.find((v) => v.scope === 'global');
    expect(globalView?.shadowed).toBe(true);

    await expect(resolveSecret('OPENAI_API_KEY', { cwd: tmpProject, actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('deleteSecret with both scopes present and no scope given throws E_AMBIGUOUS_SCOPE', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'global-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    await expect(deleteSecret('OPENAI_API_KEY', { cwd: tmpProject, actor: 'cli' })).rejects.toThrow(
      expect.objectContaining({ code: 'E_AMBIGUOUS_SCOPE' }),
    );
  });

  it('deleteSecret removes both the index entry and the underlying value', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    await deleteSecret('OPENAI_API_KEY', { scope: 'global', actor: 'cli' });

    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(false);
  });

  it('resolveSecret throws E_NOT_FOUND for a name that was never set', async () => {
    await expect(resolveSecret('NEVER_SET', { actor: 'cli' })).rejects.toThrow(EnigmaError);
  });

  it('setSecret rejects an invalid name before touching any depository', async () => {
    await expect(
      setSecret({ name: 'not-valid', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_NAME_INVALID' }));
  });

  it('resolveSecret defaults to audit op "read" when auditOp is omitted (Issue #7)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    await resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'user' });

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string });
    expect(lines.at(-1)?.op).toBe('read');
  });

  it('resolveSecret records the overridden audit op when auditOp is given (Issue #7)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    await resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'user', auditOp: 'reveal' });

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string });
    expect(lines.at(-1)?.op).toBe('reveal');
  });
});
