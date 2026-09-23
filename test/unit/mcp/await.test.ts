import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithCapabilities } from './harness.js';
import { setSecret } from '../../../src/storage/manager.js';
import { registerActiveTunnel } from '../../../src/remote/index.js';
import type { RemoteTunnel } from '../../../src/remote/types.js';
import { RequestStore } from '../../../src/request/store.js';
import { stopServer } from '../../../src/web/server.js';

/** A controllable fake RemoteTunnel: `finishUnexpectedExit()` simulates the process dying on its own (mirrors test/unit/remote/index.test.ts). */
function fakeTunnel(url: string, binary: RemoteTunnel['binary']): RemoteTunnel & { finishUnexpectedExit: () => void } {
  let resolveExit!: () => void;
  const unexpectedExit = new Promise<void>((res) => {
    resolveExit = res;
  });
  return {
    url,
    binary,
    stop: () => {},
    waitForUnexpectedExit: () => unexpectedExit,
    finishUnexpectedExit: () => resolveExit(),
  };
}

describe('enigma_await', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('an unknown request_id returns E_REQUEST_EXPIRED', async () => {
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_await', arguments: { request_id: '0'.repeat(32) } });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_REQUEST_EXPIRED');
    await pair.close();
  });

  it('an expired request_id returns E_REQUEST_EXPIRED', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: -1 });
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_REQUEST_EXPIRED');
    await pair.close();
  });

  it('blocks until the record is fulfilled, then reports the same "Stored NAME in <depository> (<scope>)" shape as enigma_request', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const pair = await connectWithCapabilities({});

    const callPromise = pair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });

    await setSecret({ name: 'OPENAI_API_KEY', value: 'sentinel-value', scope: 'global', depository: 'encrypted', actor: 'user' });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    const result = await callPromise;
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('Stored OPENAI_API_KEY in encrypted (global)');
    await pair.close();
  });

  it('when every name failed, reports isError:true and names the failures', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'] });
    const pair = await connectWithCapabilities({});

    const callPromise = pair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });

    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [
      { name: 'OPENAI_API_KEY', ok: false, errorCode: 'E_EXISTS' },
      { name: 'GITHUB_TOKEN', ok: false, errorCode: 'E_WRITE_FAILED' },
    ]);

    const result = await callPromise;
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      'OPENAI_API_KEY: failed (E_EXISTS)\nGITHUB_TOKEN: failed (E_WRITE_FAILED)',
    );
    await pair.close();
  });

  it('when some names succeeded and some failed, reports isError:false with failures led and named first', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'] });
    const pair = await connectWithCapabilities({});

    const callPromise = pair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });

    await setSecret({ name: 'GITHUB_TOKEN', value: 'sentinel-value', scope: 'global', depository: 'encrypted', actor: 'user' });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [
      { name: 'OPENAI_API_KEY', ok: false, errorCode: 'E_EXISTS' },
      { name: 'GITHUB_TOKEN', ok: true },
    ]);

    const result = await callPromise;
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe(
      'OPENAI_API_KEY: failed (E_EXISTS)\nStored GITHUB_TOKEN in encrypted (global)',
    );
    await pair.close();
  });

  it('reports a tunnel lost mid-request by mechanism name only (S2.3) — the one channel a URL-less client has for it', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const tunnel = fakeTunnel('https://await-path.trycloudflare.com', 'cloudflared');
    registerActiveTunnel(record.id, { tunnel });
    const pair = await connectWithCapabilities({});

    const callPromise = pair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });

    tunnel.finishUnexpectedExit();
    await Promise.resolve();
    await Promise.resolve();

    await setSecret({ name: 'OPENAI_API_KEY', value: 'sentinel-value', scope: 'global', depository: 'encrypted', actor: 'user' });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    const result = await callPromise;
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('Stored OPENAI_API_KEY in encrypted (global)');
    expect(text).toContain('cloudflared');
    expect(text.toLowerCase()).toContain('lost');
    expect(text).not.toContain('await-path.trycloudflare.com');
    await pair.close();
  });

  it('reports a successfully used tunnel by mechanism name, never the URL', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    registerActiveTunnel(record.id, { tunnel: fakeTunnel('https://await-path.trycloudflare.com', 'tailscale') });
    const pair = await connectWithCapabilities({});

    const callPromise = pair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });

    await setSecret({ name: 'OPENAI_API_KEY', value: 'sentinel-value', scope: 'global', depository: 'encrypted', actor: 'user' });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    const result = await callPromise;
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toBe('Stored OPENAI_API_KEY in encrypted (global)\nRemote access via tailscale was used for this request.');
    await pair.close();
  });

  it('a used-but-swept record (the human submitted but fulfill never ran) resolves with E_OUTCOME_UNKNOWN naming the declared names (Issue #69 AC #5, via the shared resolveRequestOutcome helper)', async () => {
    // Injects the OutcomeUnknownError rejection the sweeper would produce
    // after the 5-min used-grace period — avoiding fake-timer advances of
    // several minutes (slow and brittle against vitest's microtask
    // iteration limits) — and asserts the SHARED mapping in
    // resolveRequestOutcome where the amendment places it. The MCP layer
    // is tested indirectly via the existing real-round-trip cases in
    // request.test.ts and via the wire-format assertions on this
    // EnigmaError — every tool-level caller (await.ts, request.ts) goes
    // through this helper, so a single unit test covers the mapping.
    const record = RequestStore.create({
      kind: 'request',
      names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'],
    });
    const { OutcomeUnknownError } = await import('../../../src/request/store.js');
    const { resolveRequestOutcome } = await import('../../../src/mcp/request-outcome.js');

    const waiterSpy = vi
      .spyOn(RequestStore, 'waitForFulfilled')
      .mockImplementationOnce(() => Promise.reject(new OutcomeUnknownError(['OPENAI_API_KEY', 'GITHUB_TOKEN'])));

    try {
      await expect(resolveRequestOutcome(record.id, process.cwd())).rejects.toMatchObject({
        code: 'E_OUTCOME_UNKNOWN',
        message: expect.stringMatching(/OPENAI_API_KEY.*GITHUB_TOKEN.*enigma list/s),
      });
    } finally {
      waiterSpy.mockRestore();
    }
  });

  it('a never-used expiry still rejects with the generic "request expired" — never with E_OUTCOME_UNKNOWN', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const { resolveRequestOutcome } = await import('../../../src/mcp/request-outcome.js');
    const { EnigmaError } = await import('../../../src/core/errors.js');

    // Inject the plain Error('request expired') rejection the sweeper
    // produces for an unused-but-expired record — the helper must pass
    // it through unchanged, so the await tool's catch maps it to
    // E_REQUEST_EXPIRED (the code reserved for never-used expiry).
    const waiterSpy = vi
      .spyOn(RequestStore, 'waitForFulfilled')
      .mockImplementationOnce(() => Promise.reject(new Error('request expired')));

    try {
      const promise = resolveRequestOutcome(record.id, process.cwd());
      await expect(promise).rejects.toThrow(/request expired/);
      await expect(promise).rejects.not.toBeInstanceOf(EnigmaError);
    } finally {
      waiterSpy.mockRestore();
    }
  });
});
