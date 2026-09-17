import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

interface FakeStdin extends EventEmitter {
  write: (data: string) => boolean;
  end: () => void;
}

interface FakeOpCall {
  args: string[];
}

type RespondResult = { error?: (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | null; stdout?: string; stderr?: string };

/**
 * Only `enigma add --depository 1password` needs a real `op` CLI in this
 * file (Issue #28); every other test here uses `encrypted`/`env`, which
 * never spawns anything, so this default (op not installed) leaves them
 * unaffected.
 */
let respondOp: (call: FakeOpCall) => RespondResult = () => ({ error: Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' }) });

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as FakeStdin;
    stdin.write = () => true;
    stdin.end = () => {};
    const result = respondOp({ args });
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
    const child = new EventEmitter() as EventEmitter & { stdin: FakeStdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const { cmdAdd } = await import('../../../../src/cli/commands/add.js');
const { UsageError } = await import('../../../../src/cli/args.js');
const { hasSecret, resolveSecret } = await import('../../../../src/storage/manager.js');
const { indexPath, auditLogPath, secretsPath } = await import('../../../../src/core/paths.js');

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
    respondOp = () => ({ error: Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' }) });
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

  describe('1Password vault-creation confirmation (Issue #28)', () => {
    function opFail(stderr: string): RespondResult {
      return { error: new Error(`op: ${stderr}`), stderr };
    }
    function opOk(stdout: string): RespondResult {
      return { stdout };
    }
    const VAULT_MISSING_STDERR = '"Enigma" isn\'t a vault in this account';

    it('with no vault and no flag: fails with E_VAULT_MISSING naming --confirm-create-vault, and stores nothing', async () => {
      respondOp = () => opFail(VAULT_MISSING_STDERR);

      await expect(
        cmdAdd(['OPENAI_API_KEY', '--depository', '1password', '--scope', 'global'], { stdin: fakeNonTtyStdin(SENTINEL) }),
      ).rejects.toThrow(expect.objectContaining({ code: 'E_VAULT_MISSING' }));
      await expect(
        cmdAdd(['OPENAI_API_KEY', '--depository', '1password', '--scope', 'global'], { stdin: fakeNonTtyStdin(SENTINEL) }),
      ).rejects.toThrow(/--confirm-create-vault/);

      await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(false);
    });

    it('with --confirm-create-vault: creates the vault once and stores the secret', async () => {
      let itemCreateAttempts = 0;
      respondOp = (call) => {
        if (call.args[0] === 'vault' && call.args[1] === 'create') return opOk(JSON.stringify({ id: 'vaultid', name: 'Enigma' }));
        if (call.args[0] === 'item' && call.args[1] === 'create') {
          itemCreateAttempts += 1;
          if (itemCreateAttempts === 1) return opFail(VAULT_MISSING_STDERR);
          return opOk(JSON.stringify({ id: 'itemid', title: 'OPENAI_API_KEY' }));
        }
        throw new Error(`unexpected op call: ${call.args.join(' ')}`);
      };

      const code = await cmdAdd(
        ['OPENAI_API_KEY', '--depository', '1password', '--scope', 'global', '--confirm-create-vault'],
        { stdin: fakeNonTtyStdin(SENTINEL) },
      );

      expect(code).toBe(0);
      expect(itemCreateAttempts).toBe(2);
      await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);
    });

    it('is never defaulted to true: the flag absent behaves identically to it being explicitly false', async () => {
      respondOp = () => opFail(VAULT_MISSING_STDERR);

      await expect(
        cmdAdd(['OPENAI_API_KEY', '--depository', '1password', '--scope', 'global'], { stdin: fakeNonTtyStdin(SENTINEL) }),
      ).rejects.toThrow(expect.objectContaining({ code: 'E_VAULT_MISSING' }));
    });
  });
});
