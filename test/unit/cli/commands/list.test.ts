import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdList } from '../../../../src/cli/commands/list.js';
import { setSecret } from '../../../../src/storage/manager.js';
import { encryptedDepositoryModule } from '../../../../src/storage/depositories/encrypted.js';
import { envDepositoryModule } from '../../../../src/storage/depositories/env.js';

describe('cmdList', () => {
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
    vi.restoreAllMocks();
  });

  it('never touches a depository (index-only read)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });

    const encryptedCreateSpy = vi.spyOn(encryptedDepositoryModule, 'create');
    const envCreateSpy = vi.spyOn(envDepositoryModule, 'create');

    const code = await cmdList([]);

    expect(code).toBe(0);
    expect(encryptedCreateSpy).not.toHaveBeenCalled();
    expect(envCreateSpy).not.toHaveBeenCalled();
  });

  it('prints "No secrets found." when the index is empty', async () => {
    await cmdList([]);
    expect(stdoutSpy.mock.calls[0]?.[0]).toBe('No secrets found.\n');
  });

  it('marks a global entry as shadowed when a project entry of the same name exists', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'global-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'OPENAI_API_KEY', value: 'project-value', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    await cmdList(['--json']);
    const printed = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as { entries: Array<{ scope: string; shadowed?: boolean }> };
    const globalEntry = printed.entries.find((e) => e.scope === 'global');
    expect(globalEntry?.shadowed).toBe(true);
  });

  it('--json emits exactly one JSON object on stdout and nothing else', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });

    await cmdList(['--json']);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]))).not.toThrow();
  });

  it('filters by --scope', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'DB_PASSWORD', value: 'v', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    await cmdList(['--scope', 'project', '--json']);
    const printed = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as { entries: Array<{ name: string }> };
    expect(printed.entries.map((e) => e.name)).toEqual(['DB_PASSWORD']);
  });
});
