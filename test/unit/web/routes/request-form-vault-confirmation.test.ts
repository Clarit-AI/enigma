import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * request-form.test.ts mocks `op` as permanently ENOENT (signed out), which
 * only ever exercises `needsAvailabilityConfirmation`'s "depository
 * unavailable" branch. This file exercises the other branch this Issue adds
 * (#28): op *is* signed in, but the "Enigma" vault doesn't exist yet — a
 * case `detect()` deliberately can't see (its own comment explains why), so
 * it must be caught by `needsCreateVaultConfirmation`'s dedicated probe
 * instead. A parameterized `op` mock (vs. the fixed ENOENT one) is needed to
 * tell "signed in" apart from "vault missing" apart from "vault exists".
 */
type OpRespond = (args: string[]) => { error?: (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | null; stdout?: string; stderr?: string };
let respondOp: OpRespond = () => ({ stdout: '' });

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as EventEmitter & { write: (d: string) => boolean; end: () => void };
    stdin.write = () => true;
    stdin.end = () => {};
    const result = respondOp(args);
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const { startServer, stopServer } = await import('../../../../src/web/server.js');
const { RequestStore } = await import('../../../../src/request/store.js');
const { hasSecret } = await import('../../../../src/storage/manager.js');

function opOk(stdout = ''): ReturnType<OpRespond> {
  return { stdout };
}
function opFail(stderr: string): ReturnType<OpRespond> {
  return { error: new Error(`op: ${stderr}`), stderr };
}
const SIGNED_IN: OpRespond = (args) => {
  if (args.includes('--version')) return opOk('2.39.0\n');
  if (args.includes('whoami')) return opOk('{"email":"me@example.com"}\n');
  throw new Error(`unexpected op call in SIGNED_IN: ${args.join(' ')}`);
};

describe('POST /r/:id — 1Password vault-creation confirmation, signed in (Issue #28)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let origin: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();
    respondOp = () => opOk('');
    origin = (await startServer()).origin;
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('signed in but no vault: re-renders the confirmation without consuming the id (the gap the Issue #6 lane flagged)', async () => {
    respondOp = (args) => {
      if (args.includes('--version') || args.includes('whoami')) return SIGNED_IN(args);
      if (args[0] === 'vault' && args[1] === 'get') return opFail('"Enigma" isn\'t a vault in this account');
      throw new Error(`unexpected op call: ${args.join(' ')}`);
    };
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    const resp = await fetch(`${origin}/r/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ OPENAI_API_KEY: 'value', depository: '1password', scope: 'global' }).toString(),
    });

    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('1password');
    expect(html).toContain("isn't set up yet");
    expect(RequestStore.get(record.id)?.usedAt).toBeUndefined();
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(false);
  });

  it('signed in with the vault already present: stores directly, no confirmation shown', async () => {
    respondOp = (args) => {
      if (args.includes('--version') || args.includes('whoami')) return SIGNED_IN(args);
      if (args[0] === 'vault' && args[1] === 'get') return opOk(JSON.stringify({ id: 'vaultid', name: 'Enigma' }));
      if (args[0] === 'item' && args[1] === 'create') return opOk(JSON.stringify({ id: 'itemid', title: 'OPENAI_API_KEY' }));
      throw new Error(`unexpected op call: ${args.join(' ')}`);
    };
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    const resp = await fetch(`${origin}/r/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ OPENAI_API_KEY: 'value', depository: '1password', scope: 'global' }).toString(),
    });

    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).not.toContain("isn't set up yet");
    expect(html).toContain('stored');
    expect(RequestStore.get(record.id)?.usedAt).toBeDefined();
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);
  });

  it('resubmitting with confirmCreateVault creates the vault once and stores the secret', async () => {
    let itemCreateAttempts = 0;
    respondOp = (args) => {
      if (args.includes('--version') || args.includes('whoami')) return SIGNED_IN(args);
      if (args[0] === 'vault' && args[1] === 'get') return opFail('"Enigma" isn\'t a vault in this account');
      if (args[0] === 'vault' && args[1] === 'create') return opOk(JSON.stringify({ id: 'vaultid', name: 'Enigma' }));
      if (args[0] === 'item' && args[1] === 'create') {
        itemCreateAttempts += 1;
        return opOk(JSON.stringify({ id: 'itemid', title: 'OPENAI_API_KEY' }));
      }
      throw new Error(`unexpected op call: ${args.join(' ')}`);
    };
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    const resp = await fetch(`${origin}/r/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        OPENAI_API_KEY: 'value',
        depository: '1password',
        scope: 'global',
        confirmCreateVault: 'on',
      }).toString(),
    });

    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('stored');
    expect(itemCreateAttempts).toBe(1);
    expect(RequestStore.get(record.id)?.usedAt).toBeDefined();
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);
  });
});
