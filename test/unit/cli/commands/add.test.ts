import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAdd } from '../../../../src/cli/commands/add.js';
import { UsageError } from '../../../../src/cli/args.js';
import { hasSecret, resolveSecret } from '../../../../src/storage/manager.js';
import { indexPath, auditLogPath, secretsPath } from '../../../../src/core/paths.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

function fakeNonTtyStdin(line: string) {
  return {
    isTTY: false,
    setEncoding() {},
    resume() {},
    pause() {},
    on() {},
    removeListener() {},
    async *[Symbol.asyncIterator]() {
      yield `${line}\n`;
    },
  };
}

describe('cmdAdd', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let originalCwd: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

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
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('stores the prompted value and never prints it to stdout or stderr', async () => {
    const code = await cmdAdd(['OPENAI_API_KEY', '--scope', 'global'], { stdin: fakeNonTtyStdin(SENTINEL) });

    expect(code).toBe(0);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'cli' })).resolves.toBe(SENTINEL);

    const allOutput = [...stdoutSpy.mock.calls, ...stderrSpy.mock.calls].map((c: unknown[]) => String(c[0])).join('');
    expect(allOutput).not.toContain(SENTINEL);

    for (const path of [indexPath(), auditLogPath(), secretsPath()]) {
      expect(readFileSync(path, 'utf8')).not.toContain(SENTINEL);
    }
  });

  it('defaults scope to project and depository to encrypted', async () => {
    await cmdAdd(['OPENAI_API_KEY'], { stdin: fakeNonTtyStdin(SENTINEL) });

    await expect(hasSecret('OPENAI_API_KEY', { scope: 'project', cwd: tmpProject })).resolves.toBe(true);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('in encrypted (project)');
  });

  it('honors an explicit --depository', async () => {
    await cmdAdd(['OPENAI_API_KEY', '--depository', 'env', '--scope', 'project'], { stdin: fakeNonTtyStdin(SENTINEL) });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('in env (project)');
  });

  it('rejects an invalid --scope before prompting', async () => {
    await expect(cmdAdd(['OPENAI_API_KEY', '--scope', 'nope'], { stdin: fakeNonTtyStdin(SENTINEL) })).rejects.toThrow(UsageError);
  });

  it('rejects a missing NAME positional', async () => {
    await expect(cmdAdd([], { stdin: fakeNonTtyStdin(SENTINEL) })).rejects.toThrow(UsageError);
  });

  it('rejects re-adding an existing name with E_EXISTS (add never rotates)', async () => {
    await cmdAdd(['OPENAI_API_KEY', '--scope', 'global'], { stdin: fakeNonTtyStdin('first-value') });
    stdoutSpy.mockClear();
    await expect(cmdAdd(['OPENAI_API_KEY', '--scope', 'global'], { stdin: fakeNonTtyStdin(SENTINEL) })).rejects.toThrow(
      expect.objectContaining({ code: 'E_EXISTS' }),
    );
  });

  it('PR #52 review: the E_EXISTS refusal above is audited as op:"set", never "rotated" — add has no --rotate flag and never overwrote anything', async () => {
    await cmdAdd(['OPENAI_API_KEY', '--scope', 'global'], { stdin: fakeNonTtyStdin('first-value') });
    await expect(cmdAdd(['OPENAI_API_KEY', '--scope', 'global'], { stdin: fakeNonTtyStdin(SENTINEL) })).rejects.toThrow(
      expect.objectContaining({ code: 'E_EXISTS' }),
    );

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { op: string; ok: boolean });
    expect(lines.at(-1)).toMatchObject({ op: 'set', ok: false });
    expect(lines.some((l) => l.op === 'rotated')).toBe(false);
  });
});
