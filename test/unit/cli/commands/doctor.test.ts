import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Controls how the mocked `op --version` child process behaves for the next call. */
let opBehavior: { error: Error | null; stdout: string } = { error: null, stdout: '2.30.0\n' };

vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    if (opBehavior.error) callback(opBehavior.error);
    else callback(null, { stdout: opBehavior.stdout, stderr: '' });
  },
}));

const { cmdDoctor } = await import('../../../../src/cli/commands/doctor.js');
const { setSecret } = await import('../../../../src/storage/manager.js');

describe('cmdDoctor', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    opBehavior = { error: null, stdout: '2.30.0\n' };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    stdoutSpy.mockRestore();
  });

  it('--json emits exactly one JSON object on stdout with platform, depositories, config, index, and vault', async () => {
    const code = await cmdDoctor(['--json']);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const report = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(report).toHaveProperty('platform');
    expect(report).toHaveProperty('depositories');
    expect(report).toHaveProperty('op');
    expect(report).toHaveProperty('config');
    expect(report).toHaveProperty('index');
    expect(report).toHaveProperty('vault');
    expect(Array.isArray(report.depositories)).toBe(true);
  });

  it('reports the vault key as missing before any secret is stored, and present after', async () => {
    const before = JSON.parse(String((await cmdDoctorJson()))) as { vault: { keyPresent: boolean } };
    expect(before.vault.keyPresent).toBe(false);

    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });

    const after = JSON.parse(String((await cmdDoctorJson()))) as { vault: { keyPresent: boolean } };
    expect(after.vault.keyPresent).toBe(true);

    async function cmdDoctorJson() {
      stdoutSpy.mockClear();
      await cmdDoctor(['--json']);
      return stdoutSpy.mock.calls[0]?.[0];
    }
  });

  it('reports index health with the entry count', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });

    await cmdDoctor(['--json']);
    const report = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as { index: { ok: boolean; entries: number } };
    expect(report.index).toEqual({ ok: true, entries: 1 });
  });

  it('reports the 1Password CLI (op) as available with its version', async () => {
    opBehavior = { error: null, stdout: '2.30.0\n' };
    await cmdDoctor(['--json']);
    const report = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as { op: { available: boolean; version: string | null } };
    expect(report.op).toEqual({ available: true, version: '2.30.0' });
  });

  it('reports the 1Password CLI (op) as unavailable when the binary is missing', async () => {
    opBehavior = { error: Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' }), stdout: '' };
    await cmdDoctor(['--json']);
    const report = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as { op: { available: boolean; version: string | null } };
    expect(report.op).toEqual({ available: false, version: null });
  });

  it('prints human-readable text without --json', async () => {
    await cmdDoctor([]);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Platform:');
    expect(output).toContain('Depositories:');
  });

  describe('manifest gaps (Issue #13, S4.3)', () => {
    let tmpProject: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
      mkdirSync(join(tmpProject, '.git'));
      originalCwd = process.cwd();
      process.chdir(tmpProject);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      rmSync(tmpProject, { recursive: true, force: true });
    });

    it('reports "none" when .enigma.json is absent', async () => {
      await cmdDoctor(['--json']);
      const report = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as { manifestGaps: string[] };
      expect(report.manifestGaps).toEqual([]);
    });

    it('with 2 missing names, reports exactly those 2 — not more, not fewer', async () => {
      writeFileSync(
        join(tmpProject, '.enigma.json'),
        JSON.stringify({ secrets: { OPENAI_API_KEY: 'OpenAI key', GITHUB_TOKEN: 'GitHub token', REGISTERED_KEY: 'already have this one' } }),
      );
      await setSecret({ name: 'REGISTERED_KEY', value: 'v', scope: 'project', depository: 'encrypted', actor: 'cli' });

      await cmdDoctor(['--json']);
      const report = JSON.parse(String(stdoutSpy.mock.calls[0]?.[0])) as { manifestGaps: string[] };
      expect(report.manifestGaps.sort()).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    });

    it('prints "Manifest gaps: none" in human output when there are no gaps, and the names when there are', async () => {
      await cmdDoctor([]);
      expect(stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain('Manifest gaps: none');

      stdoutSpy.mockClear();
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ secrets: { MISSING_ONE: 'x' } }));
      await cmdDoctor([]);
      expect(stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain('Manifest gaps: MISSING_ONE');
    });
  });
});
