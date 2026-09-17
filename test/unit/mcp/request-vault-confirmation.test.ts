import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * enigma_request's ui:"native" path is the one MCP surface that can call
 * setSecret directly (Issue #28) — everything else the tool does for
 * 1Password's vault-creation confirmation runs on the human's web form
 * (see web/routes/request-form.test.ts). This file exercises exactly that
 * path against a real 1Password depository, with `op` and `osascript` both
 * mocked at the child_process boundary — never a real global keychain/vault
 * (PROJECT_CONTEXT.md sandboxing rules).
 */
const SENTINEL = 'sk-mcp-vault-confirm-sentinel-should-never-appear';

class FakeStream extends EventEmitter {}
class FakeDialogChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn();
}

const spawnMock = vi.fn();
type OpRespond = (args: string[]) => { error?: (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | null; stdout?: string; stderr?: string };
let respondOp: OpRespond = () => ({ error: Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' }) });

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    execFile: (_file: string, args: string[], _opts: unknown, cb: (...cbArgs: unknown[]) => void) => {
      const result = respondOp(args);
      const stdin = new EventEmitter() as EventEmitter & { write: (d: string) => boolean; end: () => void };
      stdin.write = () => true;
      stdin.end = () => {};
      queueMicrotask(() => cb(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
      const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
      child.stdin = stdin;
      child.kill = () => {};
      return child;
    },
  };
});

const { connectWithCapabilities } = await import('./harness.js');
const { hasSecret } = await import('../../../src/storage/manager.js');

function opFail(stderr: string) {
  return { error: new Error(`op: ${stderr}`), stderr };
}
function opOk(stdout: string) {
  return { stdout };
}
const VAULT_MISSING_STDERR = '"Enigma" isn\'t a vault in this account';

function emitDialogValue(child: FakeDialogChild, value: string): void {
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(`${value}\n`));
    child.emit('close', 0);
  });
}

describe('enigma_request ui:"native" — 1Password vault-creation confirmation (Issue #28)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalPlatform: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    spawnMock.mockReset();
    respondOp = () => ({ error: Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' }) });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('an unconfirmed E_VAULT_MISSING is asked about via form-mode elicitation; accepting creates the vault once and stores the secret', async () => {
    const child = new FakeDialogChild();
    spawnMock.mockImplementation(() => {
      emitDialogValue(child, SENTINEL);
      return child;
    });
    let itemCreateAttempts = 0;
    respondOp = (args) => {
      if (args[0] === 'vault' && args[1] === 'create') return opOk(JSON.stringify({ id: 'vaultid', name: 'Enigma' }));
      if (args[0] === 'item' && args[1] === 'create') {
        itemCreateAttempts += 1;
        if (itemCreateAttempts === 1) return opFail(VAULT_MISSING_STDERR);
        return opOk(JSON.stringify({ id: 'itemid', title: 'OPENAI_API_KEY' }));
      }
      throw new Error(`unexpected op call: ${args.join(' ')}`);
    };

    const pair = await connectWithCapabilities({ elicitation: { form: {} } });
    let capturedElicitation: ElicitRequest['params'] | undefined;
    pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      capturedElicitation = request.params;
      expect(request.params.mode).toBe('form');
      return { action: 'accept', content: { confirm: true } };
    });

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', depository: '1password', ui: 'native' },
    });

    expect(capturedElicitation?.message).toContain('Create it now?');
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toBe('Stored OPENAI_API_KEY in 1password (global)');
    expect(text).not.toContain(SENTINEL);
    expect(itemCreateAttempts).toBe(2);
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);
    await pair.close();
  });

  it('declining the confirmation stores nothing and reports E_VAULT_MISSING as a failure, never defaulting to create', async () => {
    const child = new FakeDialogChild();
    spawnMock.mockImplementation(() => {
      emitDialogValue(child, SENTINEL);
      return child;
    });
    respondOp = (args) => (args[0] === 'item' && args[1] === 'create' ? opFail(VAULT_MISSING_STDERR) : opOk('{}'));

    const pair = await connectWithCapabilities({ elicitation: { form: {} } });
    pair.client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', depository: '1password', ui: 'native' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_VAULT_MISSING');
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(false);
    await pair.close();
  });

  it('without form-elicitation support, refuses with a message naming confirmCreateVault instead of ever asking or defaulting', async () => {
    const child = new FakeDialogChild();
    spawnMock.mockImplementation(() => {
      emitDialogValue(child, SENTINEL);
      return child;
    });
    respondOp = (args) => (args[0] === 'item' && args[1] === 'create' ? opFail(VAULT_MISSING_STDERR) : opOk('{}'));

    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', depository: '1password', ui: 'native' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('E_VAULT_MISSING');
    expect(text).toContain('confirmCreateVault');
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(false);
    await pair.close();
  });

  it('confirmCreateVault:true supplied up front skips elicitation entirely and creates the vault directly', async () => {
    const child = new FakeDialogChild();
    spawnMock.mockImplementation(() => {
      emitDialogValue(child, SENTINEL);
      return child;
    });
    respondOp = (args) => {
      if (args[0] === 'vault' && args[1] === 'create') return opOk(JSON.stringify({ id: 'vaultid', name: 'Enigma' }));
      if (args[0] === 'item' && args[1] === 'create') return opOk(JSON.stringify({ id: 'itemid', title: 'OPENAI_API_KEY' }));
      throw new Error(`unexpected op call: ${args.join(' ')}`);
    };

    const pair = await connectWithCapabilities({ elicitation: { form: {} } });
    const elicitHandler = vi.fn();
    pair.client.setRequestHandler(ElicitRequestSchema, elicitHandler);

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: {
        names: ['OPENAI_API_KEY'],
        reason: 'test',
        usage: 'interactive',
        scope: 'global',
        depository: '1password',
        ui: 'native',
        confirmCreateVault: true,
      },
    });

    expect(elicitHandler).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);
    await pair.close();
  });
});
