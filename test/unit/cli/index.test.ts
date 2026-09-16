import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../../src/cli/index.js';

describe('cli main dispatch', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('exits 2 with usage text when no command is given', async () => {
    const code = await main([]);
    expect(code).toBe(2);
    expect(stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain('Usage: enigma');
  });

  it('exits 2 for an unknown command', async () => {
    const code = await main(['bogus']);
    expect(code).toBe(2);
    expect(stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain("unknown command 'bogus'");
  });

  it.each(['request', 'reveal', 'import', 'install'])('exits 2 for the out-of-scope command %s', async (command) => {
    const code = await main([command]);
    expect(code).toBe(2);
    expect(stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain(`enigma ${command}: not yet implemented`);
  });

  it('maps a UsageError to exit code 2', async () => {
    const code = await main(['remove']); // missing NAME
    expect(code).toBe(2);
  });

  it('maps an EnigmaError to exit code 1 with its code printed', async () => {
    const code = await main(['get', 'NEVER_SET']);
    expect(code).toBe(1);
    expect(stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain('E_NOT_FOUND');
  });

  it('returns the delegated exit code on success (doctor)', async () => {
    const code = await main(['doctor', '--json']);
    expect(code).toBe(0);
  });
});
