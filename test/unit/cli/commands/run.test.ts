import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyPath } from '../../../../src/core/paths.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

class FakeChild extends EventEmitter {}

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { cmdRun } = await import('../../../../src/cli/commands/run.js');
const { setSecret } = await import('../../../../src/storage/manager.js');

describe('cmdRun', () => {
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
    spawnMock.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    stdoutSpy.mockRestore();
  });

  it('injects only the requested secret into the child env and never prints the value', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });

    const code = await cmdRun(['--only', 'OPENAI_API_KEY', '--scope', 'global', '--', 'node', '-e', 'noop']);

    expect(code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, opts] = spawnMock.mock.calls[0]!;
    expect(command).toBe('node');
    expect(args).toEqual(['-e', 'noop']);
    expect((opts as { env: NodeJS.ProcessEnv }).env.OPENAI_API_KEY).toBe(SENTINEL);

    const printed = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(printed).not.toContain(SENTINEL);
  });

  it('resolves to the child exit code', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 7, null));
      return child;
    });

    const code = await cmdRun(['--scope', 'global', '--', 'false']);
    expect(code).toBe(7);
  });

  it('aborts before spawning when a --only name cannot be resolved', async () => {
    await expect(cmdRun(['--only', 'NEVER_SET', '--', 'echo', 'hi'])).rejects.toThrow(
      expect.objectContaining({ code: 'E_NOT_FOUND' }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('aborts before spawning with E_READ_FAILED naming the depository when the vault cannot be read', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    rmSync(keyPath()); // simulates a corrupt/missing vault key: encrypted.resolve() can no longer decrypt.

    await expect(cmdRun(['--scope', 'global', '--', 'echo', 'hi'])).rejects.toThrow(
      expect.objectContaining({ code: 'E_READ_FAILED', depository: 'encrypted' }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('requires a -- separator with a command after it', async () => {
    const { UsageError } = await import('../../../../src/cli/args.js');
    await expect(cmdRun(['--only', 'A'])).rejects.toThrow(UsageError);
    await expect(cmdRun(['--only', 'A', '--'])).rejects.toThrow(UsageError);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('excludes a shadowed global entry when no --scope/--only is given', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'global-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });

    await cmdRun(['--', 'true']);

    const [, , opts] = spawnMock.mock.calls[0]!;
    expect((opts as { env: NodeJS.ProcessEnv }).env.OPENAI_API_KEY).toBe(SENTINEL);
  });
});
