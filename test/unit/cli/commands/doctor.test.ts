import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdDoctor } from '../../../../src/cli/commands/doctor.js';
import { setSecret } from '../../../../src/storage/manager.js';

describe('cmdDoctor', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
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

  it('prints human-readable text without --json', async () => {
    await cmdDoctor([]);
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(output).toContain('Platform:');
    expect(output).toContain('Depositories:');
  });
});
