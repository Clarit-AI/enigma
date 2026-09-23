import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElicitationCompleteNotificationSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitationCompleteNotification, ElicitRequest } from '@modelcontextprotocol/sdk/types.js';

const SENTINEL = 'sk-mcp-request-sentinel-should-never-appear';

class FakeStream extends EventEmitter {}
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn();
  unref = vi.fn();
}

const spawnMock = vi.fn();
/**
 * Defaults to "cloudflared not found" (matches the fresh-Mac/CI common case,
 * Issue #12) so every pre-existing test in this file — none of which pass
 * `remote` — is unaffected: `resolveRemotePreference(undefined)` is `"none"`,
 * which never calls execFile at all. Only the remote-specific tests below
 * override this per test.
 */
const execFileMock = vi.fn();
execFileMock.mockImplementation(((_file: string, _args: string[], _opts: unknown, cb: (...cbArgs: unknown[]) => void) => {
  queueMicrotask(() => cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', ''));
  return new EventEmitter();
}) as never);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
    execFile: (...args: unknown[]) => execFileMock(...args),
  };
});

const { connectWithCapabilities } = await import('./harness.js');
const { setSecret } = await import('../../../src/storage/manager.js');
const { stopServer } = await import('../../../src/web/server.js');
const { RequestStore } = await import('../../../src/request/store.js');

describe('enigma_request', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalPlatform: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    originalPlatform = process.platform;
    RequestStore.__resetForTests();
    spawnMock.mockReset();
    execFileMock.mockReset();
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (...cbArgs: unknown[]) => void) => {
      queueMicrotask(() => cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', ''));
      return new EventEmitter();
    });
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('an existing name without rotate returns E_EXISTS and never creates a request', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_EXISTS');
    await pair.close();
  });

  it(
    'elicitation.url capability: sends a clean mode:"url" elicitation, blocks on the real HTTP round trip, and reports Stored lines',
    async () => {
      const pair = await connectWithCapabilities({ elicitation: { url: {} } });
      let capturedElicitation: ElicitRequest['params'] | undefined;
      let completeNotification: ElicitationCompleteNotification['params'] | undefined;
      pair.client.setNotificationHandler(ElicitationCompleteNotificationSchema, async (notification) => {
        completeNotification = notification.params;
      });

      pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
        capturedElicitation = request.params;
        if (request.params.mode !== 'url') throw new Error('expected url mode');

        // Simulates the human submitting the request form in a browser —
        // the sentinel travels only over this direct HTTP call, never
        // through the MCP transport above.
        await fetch(request.params.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ OPENAI_API_KEY: SENTINEL, depository: 'encrypted', scope: 'global' }).toString(),
        });

        return { action: 'accept' };
      });

      const result = await pair.client.callTool({
        name: 'enigma_request',
        arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global' },
      });

      expect(capturedElicitation?.mode).toBe('url');
      const url = (capturedElicitation as { url: string }).url;
      expect(url).not.toContain('OPENAI_API_KEY');
      expect(url).not.toContain(SENTINEL);

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toBe('Stored OPENAI_API_KEY in encrypted (global)');
      expect(text).not.toContain(SENTINEL);

      expect(capturedElicitation && 'elicitationId' in capturedElicitation ? capturedElicitation.elicitationId : undefined).toBeDefined();
      expect(completeNotification?.elicitationId).toBe(
        capturedElicitation && 'elicitationId' in capturedElicitation ? capturedElicitation.elicitationId : undefined,
      );

      await pair.close();
    },
  );

  it('partial failure over the real HTTP round trip: isError:false, failures led and named first, successes still rendered', async () => {
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      // Leaves GITHUB_TOKEN blank — request-form.ts's parseSubmission records
      // that as E_MISSING_VALUE, a genuine per-name failure produced by the
      // real HTTP route, not simulated.
      await fetch(request.params.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ OPENAI_API_KEY: SENTINEL, GITHUB_TOKEN: '', depository: 'encrypted', scope: 'global' }).toString(),
      });
      return { action: 'accept' };
    });

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['GITHUB_TOKEN', 'OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global' },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toBe('GITHUB_TOKEN: failed (E_MISSING_VALUE)\nStored OPENAI_API_KEY in encrypted (global)');
    expect(text).not.toContain(SENTINEL);
    await pair.close();
  });

  it('every name failing over the real HTTP round trip: isError:true', async () => {
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      await fetch(request.params.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ GITHUB_TOKEN: '', depository: 'encrypted', scope: 'global' }).toString(),
      });
      return { action: 'accept' };
    });

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['GITHUB_TOKEN'], reason: 'test', usage: 'interactive', scope: 'global' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('GITHUB_TOKEN: failed (E_MISSING_VALUE)');
    await pair.close();
  });

  it('decline/cancel: returns a cancelled status and never blocks on the request store', async () => {
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    pair.client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['GITHUB_TOKEN'], reason: 'test', usage: 'interactive', scope: 'global' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('cancelled');
    await pair.close();
  });

  it('without elicitation.url capability: returns request_id/url text instructing enigma_await, without calling elicitInput', async () => {
    // Empty elicitation object: the client can still register a handler (it
    // declares generic elicitation support), but per the MCP spec that
    // implies form-mode only — no url — which is exactly the capability gap
    // this test exercises.
    const pair = await connectWithCapabilities({ elicitation: {} });
    const handler = vi.fn();
    pair.client.setRequestHandler(ElicitRequestSchema, handler);

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['GITHUB_TOKEN'], reason: 'test', usage: 'interactive', scope: 'global' },
    });

    expect(handler).not.toHaveBeenCalled();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('request_id');
    expect(text).toContain('enigma_await');
    const parsed = JSON.parse(text.split('\n')[0] ?? '{}') as { request_id: string; url: string };
    expect(RequestStore.get(parsed.request_id)).toBeDefined();

    await pair.close();
  });

  it('ui:"native" on darwin never starts the HTTP server and returns the same "Stored NAME in <depository> (<scope>)" shape', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${SENTINEL}\n`));
        child.emit('close', 0);
      });
      return child;
    });

    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    const elicitHandler = vi.fn();
    pair.client.setRequestHandler(ElicitRequestSchema, elicitHandler);

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', depository: 'encrypted', ui: 'native' },
    });

    expect(elicitHandler).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toBe('Stored OPENAI_API_KEY in encrypted (global)');
    expect(text).not.toContain(SENTINEL);

    await pair.close();
  });

  it('ui:"native" partial failure (second dialog cancelled): isError:false, the failure led and named, the earlier success still reported', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const children = [new FakeChild(), new FakeChild()];
    let call = 0;
    spawnMock.mockImplementation(() => {
      const index = call;
      call += 1;
      const child = children[index]!;
      queueMicrotask(() => {
        if (index === 0) {
          child.stdout.emit('data', Buffer.from(`${SENTINEL}\n`));
          child.emit('close', 0);
        } else {
          child.stderr.emit('data', Buffer.from('35:36: execution error: User canceled. (-128)\n'));
          child.emit('close', 1);
        }
      });
      return child;
    });

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'], reason: 'test', usage: 'interactive', scope: 'global', depository: 'encrypted', ui: 'native' },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toBe('GITHUB_TOKEN: failed (E_REQUEST_CANCELLED)\nStored OPENAI_API_KEY in encrypted (global)');
    await pair.close();
  });

  it('ui:"native" all failed (first dialog cancelled): isError:true', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('35:36: execution error: User canceled. (-128)\n'));
        child.emit('close', 1);
      });
      return child;
    });

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', depository: 'encrypted', ui: 'native' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('OPENAI_API_KEY: failed (E_REQUEST_CANCELLED)');
    await pair.close();
  });
});

describe('enigma_request remote access (Issue #12)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();
    spawnMock.mockReset();
    execFileMock.mockReset();
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function stubCloudflaredMissing(): void {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (...cbArgs: unknown[]) => void) => {
      queueMicrotask(() => cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', ''));
      return new EventEmitter();
    });
  }

  /** cloudflared's `--version` probe succeeds; its `tunnel --url ...` spawn (via `spawn`, not `execFile`) prints a trycloudflare URL on stderr. */
  function stubCloudflaredAvailable(): FakeChild {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: (...cbArgs: unknown[]) => void) => {
      queueMicrotask(() => cb(null, 'cloudflared version 2024.1.0', ''));
      return new EventEmitter();
    });
    const tunnelChild = new FakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        tunnelChild.stderr.emit('data', Buffer.from('https://remote-words.trycloudflare.com\n'));
      });
      return tunnelChild;
    });
    return tunnelChild;
  }

  it('remote:true + cloudflared missing: E_REMOTE_UNAVAILABLE naming cloudflared, no request created, nothing elicited', async () => {
    stubCloudflaredMissing();
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    const elicitHandler = vi.fn();
    pair.client.setRequestHandler(ElicitRequestSchema, elicitHandler);

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', remote: true },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_REMOTE_UNAVAILABLE');
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('cloudflared');
    expect(elicitHandler).not.toHaveBeenCalled();
    await pair.close();
  });

  it('remote:"prefer" + cloudflared missing: proceeds locally over the real HTTP round trip and names the fallback in the final text', async () => {
    stubCloudflaredMissing();
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    let elicitedUrl = '';
    pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      elicitedUrl = request.params.url;
      await fetch(request.params.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ OPENAI_API_KEY: SENTINEL, depository: 'encrypted', scope: 'global' }).toString(),
      });
      return { action: 'accept' };
    });

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', remote: 'prefer' },
    });

    expect(elicitedUrl).toContain('127.0.0.1');
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('Stored OPENAI_API_KEY in encrypted (global)');
    expect(text).toContain('Remote access unavailable');
    expect(text).toContain('cloudflared');
    await pair.close();
  });

  it('remote:true + cloudflared available: elicits the tunnel URL, and the final text reports remote access was used', async () => {
    stubCloudflaredAvailable();
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    let elicitedUrl = '';
    pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      elicitedUrl = request.params.url;
      return { action: 'accept' };
    });

    // The tunnel URL (https://remote-words.trycloudflare.com/r/<id>) is a
    // scrape target, not a real server that can proxy an HTTP round trip in
    // this test — read back the request id the tool elicited and fulfil it
    // directly through the store instead, exactly the way the real /r/:id
    // route does once a human submits the form.
    const resultPromise = pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', depository: 'encrypted', remote: true },
    });

    await vi.waitFor(() => expect(elicitedUrl).toContain('trycloudflare.com'));
    expect(elicitedUrl).toMatch(/^https:\/\/remote-words\.trycloudflare\.com\/r\/[0-9a-f]{32}$/);
    const requestId = elicitedUrl.split('/r/')[1]!;
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'user' });
    RequestStore.fulfill(requestId, [{ name: 'OPENAI_API_KEY', ok: true }]);

    const result = await resultPromise;
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('Remote access via cloudflared was used for this request.');
    expect(text).not.toContain(SENTINEL);
    await pair.close();
  });

  it('remote:true + tunnel dies mid-request: the local link still works and the final text names the loss, never the URL', async () => {
    const tunnelChild = stubCloudflaredAvailable();
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    let elicitedUrl = '';
    pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      elicitedUrl = request.params.url;
      return { action: 'accept' };
    });

    const resultPromise = pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', depository: 'encrypted', remote: true },
    });

    await vi.waitFor(() => expect(elicitedUrl).toContain('trycloudflare.com'));
    const requestId = elicitedUrl.split('/r/')[1]!;

    // The tunnel process dies on its own (not via stop()) before the human
    // ever submits the form — S2.3.
    tunnelChild.emit('exit', 137);
    await Promise.resolve();
    await Promise.resolve();

    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'user' });
    RequestStore.fulfill(requestId, [{ name: 'OPENAI_API_KEY', ok: true }]);

    const result = await resultPromise;
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('Stored OPENAI_API_KEY in encrypted (global)');
    expect(text).toContain('cloudflared');
    expect(text.toLowerCase()).toContain('lost');
    expect(text).not.toContain('trycloudflare.com');
    expect(text).not.toContain(SENTINEL);
    await pair.close();
  });

  it(
    'remote:true + a client without URL-mode elicitation: E_REMOTE_UNAVAILABLE naming the real reason, no request created, no binary ever probed',
    async () => {
      // Tech Lead ruling on PR #35, round 2, item 2: such a client has no
      // sanctioned out-of-band channel at all — the fallback branch returns
      // its URL as literal tool-result text — so remote access must never
      // even be attempted, not attempted and then hidden.
      const pair = await connectWithCapabilities({ elicitation: {} });
      const elicitHandler = vi.fn();
      pair.client.setRequestHandler(ElicitRequestSchema, elicitHandler);

      const result = await pair.client.callTool({
        name: 'enigma_request',
        arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', remote: true },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toContain('E_REMOTE_UNAVAILABLE');
      expect(text).toContain('URL-mode elicitation');
      expect(elicitHandler).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      await pair.close();
    },
  );

  it(
    'remote:"prefer" + a client without URL-mode elicitation: the fallback URL is the LOCAL origin, never a tunnel origin, and names why',
    async () => {
      const pair = await connectWithCapabilities({ elicitation: {} });
      const elicitHandler = vi.fn();
      pair.client.setRequestHandler(ElicitRequestSchema, elicitHandler);

      const result = await pair.client.callTool({
        name: 'enigma_request',
        arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', remote: 'prefer' },
      });

      expect(elicitHandler).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();

      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      const parsed = JSON.parse(text.split('\n')[0] ?? '{}') as { request_id: string; url: string };
      expect(parsed.url).toContain('127.0.0.1');
      expect(parsed.url).not.toContain('trycloudflare.com');
      expect(text).toContain('Remote access unavailable');
      expect(text).toContain('URL-mode elicitation');
      await pair.close();
    },
  );

  it('RequestStore.create throwing after a tunnel started stops the tunnel before the error surfaces (guard for QA finding on PR #35; currently unreachable given zod bounds)', async () => {
    const tunnelChild = stubCloudflaredAvailable();
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    pair.client.setRequestHandler(ElicitRequestSchema, vi.fn());

    const createSpy = vi.spyOn(RequestStore, 'create').mockImplementationOnce(() => {
      throw new Error('simulated RequestStore.create failure');
    });

    const result = await pair.client.callTool({
      name: 'enigma_request',
      arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global', remote: true },
    });

    createSpy.mockRestore();
    expect(result.isError).toBe(true);
    expect(tunnelChild.kill).toHaveBeenCalledWith('SIGTERM');
    await pair.close();
  });

  it('blocking enigma_request: a NEVER-USED expiry yields structured E_REQUEST_EXPIRED through the shared mapper (Kimi QA AC5 regression — was: untyped Error rethrown as an unhandled tool failure)', async () => {
    // Drives the real blocking tool path end to end (URL-mode accept →
    // resolveRequestOutcome), injecting only the store's typed
    // RequestExpiredError rejection — exactly what expireRecord/waitForFulfilled
    // produce for a never-used record. request.ts's catch passes the mapper's
    // EnigmaError to errorResult, so the wire text must carry the code.
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      return { action: 'accept' };
    });

    const { RequestExpiredError } = await import('../../../src/request/store.js');
    const waiterSpy = vi
      .spyOn(RequestStore, 'waitForFulfilled')
      .mockImplementationOnce(() => Promise.reject(new RequestExpiredError()));

    try {
      const result = await pair.client.callTool({
        name: 'enigma_request',
        arguments: { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global' },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      expect(text).toContain('E_REQUEST_EXPIRED');
      expect(text).not.toContain('E_OUTCOME_UNKNOWN');
    } finally {
      waiterSpy.mockRestore();
    }
    await pair.close();
  });

  it('blocking enigma_request: a used-but-swept record yields E_OUTCOME_UNKNOWN through the shared resolveRequestOutcome mapping (Issue #69 AC #5)', async () => {
    // Injects the OutcomeUnknownError rejection the sweeper would produce
    // after the 5-min used-grace period — avoiding fake-timer advances of
    // several minutes (slow and brittle against vitest's microtask
    // iteration limits) — and asserts the SHARED mapping in
    // resolveRequestOutcome where the amendment places it. request.ts's
    // catch block (passes EnigmaError to errorResult) is the only branch
    // between the helper and the wire, and errorResult is already
    // exhaustively covered by other tests.
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'] });
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
});
