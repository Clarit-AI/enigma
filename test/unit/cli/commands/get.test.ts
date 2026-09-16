import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdGet } from '../../../../src/cli/commands/get.js';
import { UsageError } from '../../../../src/cli/args.js';
import { setSecret } from '../../../../src/storage/manager.js';
import { auditLogPath } from '../../../../src/core/paths.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

describe('cmdGet', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('prints the value on stdout and a warning on stderr', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    const code = await cmdGet(['OPENAI_API_KEY', '--scope', 'global']);

    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledWith(`${SENTINEL}\n`);
    expect(stderrSpy.mock.calls.some((c: unknown[]) => String(c[0]).toLowerCase().includes('warning'))).toBe(true);
  });

  it('audits a read with actor cli', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    await cmdGet(['OPENAI_API_KEY', '--scope', 'global']);

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]!) as { op: string; actor: string; ok: boolean };
    expect(last).toMatchObject({ op: 'read', actor: 'cli', ok: true });
  });

  it('throws E_NOT_FOUND for a name that was never set', async () => {
    await expect(cmdGet(['NEVER_SET'])).rejects.toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }));
  });

  it('rejects a missing NAME positional', async () => {
    await expect(cmdGet([])).rejects.toThrow(UsageError);
  });
});
