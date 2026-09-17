import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnigmaError } from '../../src/core/errors.js';
import { auditLogPath } from '../../src/core/paths.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

/**
 * `1password` is the only depository that reads `DepositoryContext` at
 * construction time for something other than `env`'s file location, so it's
 * the concrete case used below to pin that `setSecret` actually forwards
 * `projectPath`/`createVault` through to the depository rather than only to
 * `env` (manager.ts previously special-cased `env` alone here — a latent
 * gap `resolveSecret`/`deleteSecret` never had). Mocking `child_process`
 * keeps this deterministic regardless of whether `op` is installed/signed
 * in on the machine running the suite.
 */
interface FakeCall {
  args: string[];
  stdinData: string;
}
const opCalls: FakeCall[] = [];
let respondToOp: (call: FakeCall) => { stdout?: string; stderr?: string; fail?: boolean };

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as EventEmitter & { write: (d: string) => boolean; end: () => void };
    const call: FakeCall = { args, stdinData: '' };
    stdin.write = (data: string) => {
      call.stdinData += data;
      return true;
    };
    stdin.end = () => {};
    opCalls.push(call);
    const result = respondToOp(call);
    queueMicrotask(() => {
      if (result.fail) {
        callback(Object.assign(new Error('op failure'), {}), result.stdout ?? '', result.stderr ?? '');
      } else {
        callback(null, result.stdout ?? '', result.stderr ?? '');
      }
    });
    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const { deleteSecret, hasSecret, listSecrets, resolveSecret, setSecret } = await import('../../src/storage/manager.js');

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
    opCalls.length = 0;
    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        return { stdout: JSON.stringify({ id: 'opitemid', title: 'x', category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };
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

  it('Issue #39: the E_SCOPE_INVALID refusal above is audited, even though it throws before any depository or index access', async () => {
    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'env', actor: 'cli' }),
    ).rejects.toThrow();

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string; name: string; ok: boolean; error: string | null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'OPENAI_API_KEY', ok: false });
    expect(lines[0]?.error).toContain('E_SCOPE_INVALID');
  });

  it('set on an existing name without rotate throws E_EXISTS', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: 'new-value', scope: 'global', depository: 'encrypted', actor: 'cli' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_EXISTS' }));
  });

  it('Issue #39: the E_EXISTS refusal above is audited too — a caller reading the log sees the refusal, not silence', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: 'new-value', scope: 'global', depository: 'encrypted', actor: 'cli' }),
    ).rejects.toThrow();

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string; name: string; ok: boolean; error: string | null });
    // Line 0 is the first, successful set (op: 'set', ok: true); line 1 is the refusal.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ name: 'OPENAI_API_KEY', ok: false });
    expect(lines[1]?.error).toContain('E_EXISTS');
    // Never the value, in either the successful or the refused line.
    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    expect(JSON.stringify(lines)).not.toContain('new-value');
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

  it('setSecret forwards projectPath to a non-env, project-scoped depository (Issue #6 — was previously env-only, a latent gap versus resolveSecret/deleteSecret)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: '1password', cwd: tmpProject, actor: 'cli' });

    const itemCreateCall = opCalls.find((c) => c.args[0] === 'item' && c.args[1] === 'create');
    expect(itemCreateCall).toBeDefined();
    const template = JSON.parse(itemCreateCall!.stdinData) as { title: string };
    expect(template.title).toBe(`OPENAI_API_KEY · ${basename(tmpProject)}`);
  });

  it('setSecret rejects with E_VAULT_MISSING and creates nothing when the vault is missing and createVault was not passed', async () => {
    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        return { fail: true, stderr: '"Enigma" isn\'t a vault in this account' };
      }
      return { stdout: '' };
    };

    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: '1password', actor: 'cli' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_VAULT_MISSING' }));
    expect(opCalls.some((c) => c.args[0] === 'vault' && c.args[1] === 'create')).toBe(false);
  });

  it('setSecret end-to-end: createVault reaches the depository via DepositoryContext and creates the vault exactly once', async () => {
    let itemCreateAttempts = 0;
    respondToOp = (call) => {
      if (call.args[0] === 'vault' && call.args[1] === 'create') {
        return { stdout: JSON.stringify({ id: 'vaultid', name: 'Enigma' }) };
      }
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        itemCreateAttempts += 1;
        if (itemCreateAttempts === 1) return { fail: true, stderr: '"Enigma" isn\'t a vault in this account' };
        return { stdout: JSON.stringify({ id: 'opitemid', title: 'x', category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };

    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: '1password', createVault: true, actor: 'cli' });

    expect(opCalls.filter((c) => c.args[0] === 'vault' && c.args[1] === 'create')).toHaveLength(1);
    const [entry] = listSecrets({ scope: 'global' });
    expect(entry?.ref).toBe('opitemid');
  });
});
