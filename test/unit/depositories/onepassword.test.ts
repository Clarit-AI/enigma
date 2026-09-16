import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnigmaError } from '../../../src/core/errors.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

interface FakeStdin extends EventEmitter {
  write: (data: string) => boolean;
  end: () => void;
}

interface FakeCall {
  file: string;
  args: string[];
  stdinData: string;
  stdin: FakeStdin;
  writeReturn: boolean;
}

type RespondResult = {
  error?: (NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string | null }) | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
};

const calls: FakeCall[] = [];
let respond: (call: FakeCall) => RespondResult;

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as FakeStdin;
    const call: FakeCall = { file, args, stdinData: '', stdin, writeReturn: true };
    stdin.write = (data: string) => {
      call.stdinData += data;
      return call.writeReturn;
    };
    stdin.end = () => {};
    calls.push(call);
    const result = respond(call);
    queueMicrotask(() => {
      if (result.timedOut) {
        const err = Object.assign(new Error('op: timeout'), { killed: true, signal: 'SIGTERM' });
        callback(err, result.stdout ?? '', result.stderr ?? '');
        return;
      }
      callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
    });
    const child = new EventEmitter() as EventEmitter & { stdin: FakeStdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const { onepasswordDepositoryModule } = await import('../../../src/storage/depositories/onepassword.js');

function okResult(stdout = ''): RespondResult {
  return { stdout };
}

function itemCreateOk(id: string): RespondResult {
  return { stdout: JSON.stringify({ id, title: 'whatever', category: 'API_CREDENTIAL' }) };
}

function opError(stderr: string): RespondResult {
  const error = new Error(`op: ${stderr}`) as NodeJS.ErrnoException;
  return { error, stderr };
}

function enoent(): RespondResult {
  const error = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
  return { error, stderr: '' };
}

describe('onepassword depository', () => {
  beforeEach(() => {
    calls.length = 0;
    respond = () => okResult();
  });

  it('registers id 1password and promptProfile prompts-each-read', () => {
    expect(onepasswordDepositoryModule.id).toBe('1password');
    expect(onepasswordDepositoryModule.promptProfile).toBe('prompts-each-read');
  });

  describe('detect', () => {
    it('is available when op --version is 2.x+ and op whoami succeeds, without prompting', async () => {
      respond = (call) => {
        if (call.args.includes('--version')) return okResult('2.39.0\n');
        if (call.args.includes('whoami')) return okResult('{"email":"me@example.com"}\n');
        throw new Error(`unexpected call: ${call.args.join(' ')}`);
      };

      const result = await onepasswordDepositoryModule.detect();

      expect(result).toEqual({ id: '1password', promptProfile: 'prompts-each-read', available: true });
      expect(calls).toHaveLength(2);
      expect(calls.some((c) => c.args.includes('vault') || c.args.includes('item'))).toBe(false);
    });

    it('reports unavailable with a reason and does not throw when op is not signed in (this host’s actual state)', async () => {
      respond = (call) => {
        if (call.args.includes('--version')) return okResult('2.39.0\n');
        return opError('account is not signed in');
      };

      const result = await onepasswordDepositoryModule.detect();

      expect(result.available).toBe(false);
      expect(result.reason).toMatch(/signed in|signin/i);
      expect(result.id).toBe('1password');
    });

    it('reports unavailable with a reason when op is not installed (ENOENT), never throwing', async () => {
      respond = () => enoent();

      const result = await onepasswordDepositoryModule.detect();

      expect(result.available).toBe(false);
      expect(result.reason).toContain('not installed');
    });

    it('reports unavailable when the installed op CLI is older than v2', async () => {
      respond = (call) => {
        if (call.args.includes('--version')) return okResult('1.12.0\n');
        throw new Error('should not check whoami when version is too old');
      };

      const result = await onepasswordDepositoryModule.detect();

      expect(result.available).toBe(false);
      expect(result.reason).toContain('2');
    });

    it('never spawns anything beyond --version and whoami', async () => {
      respond = (call) => {
        if (call.args.includes('--version')) return okResult('2.0.0\n');
        return okResult('{}\n');
      };
      const result = await onepasswordDepositoryModule.detect();
      expect(result.available).toBe(true);
      for (const call of calls) {
        expect(call.stdinData).toBe('');
      }
    });
  });

  describe('set', () => {
    it('creates an API Credential item with the value on stdin, never argv, and returns the item id', async () => {
      respond = () => itemCreateOk('abc123itemid');
      const depo = onepasswordDepositoryModule.create({});

      const ref = await depo.set('global/OPENAI_API_KEY', SENTINEL);

      expect(ref).toBe('abc123itemid');
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.file).toBe('op');
      expect(call.args).toEqual(['item', 'create', '--vault', 'Enigma', '--format', 'json', '-']);
      for (const arg of call.args) {
        expect(arg).not.toContain(SENTINEL);
      }
      expect(call.stdinData).toContain(SENTINEL);
      const template = JSON.parse(call.stdinData) as { title: string; category: string; fields: Array<{ id: string; value: string }> };
      expect(template.category).toBe('API_CREDENTIAL');
      expect(template.fields[0]?.id).toBe('credential');
      expect(template.fields[0]?.value).toBe(SENTINEL);
    });

    it('titles a global-scope item as the bare NAME', async () => {
      respond = () => itemCreateOk('id1');
      const depo = onepasswordDepositoryModule.create({});

      await depo.set('global/OPENAI_API_KEY', SENTINEL);

      const template = JSON.parse(calls[0]!.stdinData) as { title: string };
      expect(template.title).toBe('OPENAI_API_KEY');
    });

    it('titles a project-scope item as NAME · <project folder> using DepositoryContext.projectPath', async () => {
      respond = () => itemCreateOk('id1');
      const depo = onepasswordDepositoryModule.create({ projectPath: '/Users/dev/my-cool-project' });

      await depo.set('9f3a1b2c3d4e5f60/OPENAI_API_KEY', SENTINEL);

      const template = JSON.parse(calls[0]!.stdinData) as { title: string };
      expect(template.title).toBe('OPENAI_API_KEY · my-cool-project');
    });

    it('falls back to the bare NAME title, never throwing, when projectPath is absent for a project-scoped ref', async () => {
      respond = () => itemCreateOk('id1');
      const depo = onepasswordDepositoryModule.create({});

      await depo.set('9f3a1b2c3d4e5f60/OPENAI_API_KEY', SENTINEL);

      const template = JSON.parse(calls[0]!.stdinData) as { title: string };
      expect(template.title).toBe('OPENAI_API_KEY');
    });

    it('throws E_VAULT_MISSING and creates nothing when the vault is missing and createVault was not passed', async () => {
      respond = () => opError('"Enigma" isn\'t a vault in this account');
      const depo = onepasswordDepositoryModule.create({});

      await expect(depo.set('global/NAME', SENTINEL)).rejects.toThrow(
        expect.objectContaining({ code: 'E_VAULT_MISSING', depository: '1password' }),
      );
      expect(calls).toHaveLength(1);
      expect(calls.some((c) => c.args.includes('create') && c.args.includes('vault'))).toBe(false);
    });

    it('creates the vault exactly once and retries when createVault is true, then succeeds', async () => {
      let itemCreateAttempts = 0;
      respond = (call) => {
        if (call.args[0] === 'vault' && call.args[1] === 'create') {
          return okResult(JSON.stringify({ id: 'vaultid', name: 'Enigma' }));
        }
        if (call.args[0] === 'item' && call.args[1] === 'create') {
          itemCreateAttempts += 1;
          if (itemCreateAttempts === 1) return opError('"Enigma" isn\'t a vault in this account');
          return itemCreateOk('id-after-vault-create');
        }
        throw new Error(`unexpected call: ${call.args.join(' ')}`);
      };
      const depo = onepasswordDepositoryModule.create({ createVault: true });

      const ref = await depo.set('global/NAME', SENTINEL);

      expect(ref).toBe('id-after-vault-create');
      expect(itemCreateAttempts).toBe(2);
      expect(calls.filter((c) => c.args[0] === 'vault' && c.args[1] === 'create')).toHaveLength(1);
    });

    it('throws E_WRITE_FAILED when vault creation itself fails', async () => {
      respond = (call) => {
        if (call.args[0] === 'vault' && call.args[1] === 'create') return opError('some vault creation failure');
        return opError('"Enigma" isn\'t a vault in this account');
      };
      const depo = onepasswordDepositoryModule.create({ createVault: true });

      await expect(depo.set('global/NAME', SENTINEL)).rejects.toThrow(
        expect.objectContaining({ code: 'E_WRITE_FAILED', depository: '1password' }),
      );
    });

    it('throws a distinct, signin-pointing E_WRITE_FAILED on timeout, never hanging past the bound', async () => {
      respond = () => ({ timedOut: true });
      const depo = onepasswordDepositoryModule.create({});

      try {
        await depo.set('global/NAME', SENTINEL);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(EnigmaError);
        expect((err as EnigmaError).code).toBe('E_WRITE_FAILED');
        expect((err as EnigmaError).message).toMatch(/signin|sign in|unlock/i);
        expect((err as EnigmaError).message).not.toContain(SENTINEL);
      }
    });

    it('throws E_WRITE_FAILED when op returns unparsable JSON', async () => {
      respond = () => ({ stdout: 'not json' });
      const depo = onepasswordDepositoryModule.create({});

      await expect(depo.set('global/NAME', SENTINEL)).rejects.toThrow(
        expect.objectContaining({ code: 'E_WRITE_FAILED' }),
      );
    });

    it('rejects an invalid ref before spawning anything', async () => {
      const depo = onepasswordDepositoryModule.create({});

      await expect(depo.set('global/NAME; rm -rf /', SENTINEL)).rejects.toThrow(
        expect.objectContaining({ code: 'E_REF_INVALID' }),
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('resolve', () => {
    it('runs op read op://Enigma/<id>/credential with no stdin and returns the value', async () => {
      respond = () => okResult(`${SENTINEL}\n`);
      const depo = onepasswordDepositoryModule.create({});

      const value = await depo.resolve('abc123itemid');

      expect(value).toBe(SENTINEL);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual(['read', 'op://Enigma/abc123itemid/credential']);
      expect(calls[0]!.stdinData).toBe('');
    });

    it('throws E_NOT_FOUND when the item is missing', async () => {
      respond = () => opError('"op://Enigma/missing/credential" isn\'t an item in this vault');
      const depo = onepasswordDepositoryModule.create({});

      await expect(depo.resolve('missing')).rejects.toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }));
    });

    it('throws E_READ_FAILED naming 1password on any other failure, never including the value', async () => {
      respond = () => opError('some other failure');
      const depo = onepasswordDepositoryModule.create({});

      try {
        await depo.resolve('abc123itemid');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(EnigmaError);
        expect((err as EnigmaError).code).toBe('E_READ_FAILED');
        expect((err as EnigmaError).depository).toBe('1password');
        expect((err as EnigmaError).message).not.toContain(SENTINEL);
      }
    });

    it('throws a distinct, signin-pointing E_READ_FAILED on timeout — the most user-visible hang risk (read at session start)', async () => {
      respond = () => ({ timedOut: true });
      const depo = onepasswordDepositoryModule.create({});

      try {
        await depo.resolve('abc123itemid');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(EnigmaError);
        expect((err as EnigmaError).code).toBe('E_READ_FAILED');
        expect((err as EnigmaError).message).toMatch(/signin|sign in|unlock/i);
      }
    });

    it('rejects an invalid ref before spawning anything', async () => {
      const depo = onepasswordDepositoryModule.create({});

      await expect(depo.resolve('bad ref!')).rejects.toThrow(expect.objectContaining({ code: 'E_REF_INVALID' }));
      expect(calls).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('runs op item delete <id> --vault Enigma with only the ref in argv', async () => {
      respond = () => okResult();
      const depo = onepasswordDepositoryModule.create({});

      await depo.delete('abc123itemid');

      expect(calls[0]!.args).toEqual(['item', 'delete', 'abc123itemid', '--vault', 'Enigma']);
    });

    it('is idempotent when the item is already missing', async () => {
      respond = () => opError('isn\'t an item in this vault');
      const depo = onepasswordDepositoryModule.create({});

      await expect(depo.delete('missing')).resolves.toBeUndefined();
    });

    it('throws E_READ_FAILED on a non-missing failure', async () => {
      respond = () => opError('some other failure');
      const depo = onepasswordDepositoryModule.create({});

      await expect(depo.delete('abc123itemid')).rejects.toThrow(expect.objectContaining({ code: 'E_READ_FAILED' }));
    });

    it('rejects an invalid ref before spawning anything', async () => {
      const depo = onepasswordDepositoryModule.create({});

      await expect(depo.delete('bad ref!')).rejects.toThrow(expect.objectContaining({ code: 'E_REF_INVALID' }));
      expect(calls).toHaveLength(0);
    });
  });

  describe('has', () => {
    it('returns true when found', async () => {
      respond = () => okResult();
      const depo = onepasswordDepositoryModule.create({});
      await expect(depo.has('abc123itemid')).resolves.toBe(true);
    });

    it('returns false when missing or any other failure', async () => {
      respond = () => opError('not found');
      const depo = onepasswordDepositoryModule.create({});
      await expect(depo.has('missing')).resolves.toBe(false);
    });

    it('rejects an invalid ref before spawning anything', async () => {
      const depo = onepasswordDepositoryModule.create({});
      await expect(depo.has('bad ref!')).rejects.toThrow(expect.objectContaining({ code: 'E_REF_INVALID' }));
      expect(calls).toHaveLength(0);
    });
  });
});

const RUN_E2E_OP = process.env.ENIGMA_E2E_OP === '1';

// Opt-in real-op round-trip (ENIGMA_E2E_OP=1): exercises the actual `op`
// binary against the real signed-in account, using a unique, disposable
// item that is always deleted afterward. Skips cleanly (describe.runIf)
// rather than failing when not explicitly requested — the default suite
// never touches the real binary, so it behaves identically whether or not
// `op` is installed or signed in on the machine running it.
describe.runIf(RUN_E2E_OP)('onepassword E2E (real op CLI)', () => {
  it('round-trips a sentinel value and deletes it', async () => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    const real = await import('../../../src/storage/depositories/onepassword.js');
    const depo = real.onepasswordDepositoryModule.create({ createVault: true });
    const ref = `global/ENIGMA_E2E_OP_TEST_${Date.now()}`;
    const value = `e2e-sentinel-${Date.now()}`;

    let itemId: string | undefined;
    try {
      itemId = await depo.set(ref, value);
      await expect(depo.resolve(itemId)).resolves.toBe(value);
      await expect(depo.has(itemId)).resolves.toBe(true);
    } finally {
      if (itemId) await depo.delete(itemId);
    }
  });
});
