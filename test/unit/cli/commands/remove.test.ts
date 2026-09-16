import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdRemove } from '../../../../src/cli/commands/remove.js';
import { UsageError } from '../../../../src/cli/args.js';
import { hasSecret, setSecret } from '../../../../src/storage/manager.js';

describe('cmdRemove', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let originalCwd: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    // Resolved so it matches process.cwd() after chdir on platforms where tmpdir() is a symlink (e.g. macOS).
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    originalCwd = process.cwd();
    process.chdir(tmpProject);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    stdoutSpy.mockRestore();
  });

  it('removes the index entry and underlying value', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });

    const code = await cmdRemove(['OPENAI_API_KEY', '--scope', 'global']);

    expect(code).toBe(0);
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(false);
  });

  it('rejects a missing NAME positional with UsageError', async () => {
    await expect(cmdRemove([])).rejects.toThrow(UsageError);
  });

  it('throws E_AMBIGUOUS_SCOPE when both scopes hold the name and none was given', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    await expect(cmdRemove(['OPENAI_API_KEY'])).rejects.toThrow(expect.objectContaining({ code: 'E_AMBIGUOUS_SCOPE' }));
  });

  it('throws E_NOT_FOUND for a name that was never set', async () => {
    await expect(cmdRemove(['NEVER_SET', '--scope', 'global'])).rejects.toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }));
  });
});
