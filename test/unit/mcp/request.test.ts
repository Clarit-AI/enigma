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
}

const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
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
});
