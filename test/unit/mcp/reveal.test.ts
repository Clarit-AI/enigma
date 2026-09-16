import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElicitationCompleteNotificationSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';

const SENTINEL = 'sk-mcp-reveal-sentinel-should-never-appear';

class FakeStream extends EventEmitter {}
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn();
}

let clipboard = '';
const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

const { connectWithCapabilities } = await import('./harness.js');
const { setSecret } = await import('../../../src/storage/manager.js');
const { stopServer } = await import('../../../src/web/server.js');
const { RequestStore } = await import('../../../src/request/store.js');

function mockClipboardBinaries(): void {
  spawnMock.mockImplementation((command: string) => {
    const child = new FakeChild();
    queueMicrotask(() => {
      if (command === 'pbpaste') child.stdout.emit('data', Buffer.from(clipboard));
      if (command === 'pbcopy') {
        child.stdin.write = vi.fn((data: string) => {
          clipboard = data;
        }) as never;
      }
      child.emit('close', 0);
    });
    return child;
  });
}

describe('enigma_reveal', () => {
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
    clipboard = '';
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('method:"page" with elicitation.url: sends a clean mode:"url" elicitation and returns immediately without blocking on fulfilment', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    let capturedElicitation: ElicitRequest['params'] | undefined;
    let acknowledgeElicitation: (() => void) | undefined;

    pair.client.setRequestHandler(ElicitRequestSchema, (request) => {
      capturedElicitation = request.params;
      // Does not fetch the reveal page — proves the tool call does not wait
      // for the human to actually reveal anything before returning.
      return new Promise((resolve) => {
        acknowledgeElicitation = () => resolve({ action: 'accept' });
      });
    });

    const callPromise = pair.client.callTool({ name: 'enigma_reveal', arguments: { name: 'OPENAI_API_KEY', scope: 'global' } });
    await vi.waitFor(() => expect(acknowledgeElicitation).toBeDefined());
    acknowledgeElicitation!();
    const result = await callPromise;

    expect(capturedElicitation?.mode).toBe('url');
    const url = (capturedElicitation as { url: string }).url;
    expect(url).not.toContain('OPENAI_API_KEY');
    expect(url).not.toContain(SENTINEL);

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toBe('Reveal link opened; expires in 5 min');
    expect(text).not.toContain(SENTINEL);

    await pair.close();
  });

  it('sends notifications/elicitation/complete once the human actually reveals it (fire-and-forget, after the tool call already returned)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    let revealUrl: string | undefined;
    let completeNotification: { elicitationId: string } | undefined;

    pair.client.setNotificationHandler(ElicitationCompleteNotificationSchema, async (notification) => {
      completeNotification = notification.params;
    });
    pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      revealUrl = request.params.url;
      return { action: 'accept' };
    });

    const result = await pair.client.callTool({ name: 'enigma_reveal', arguments: { name: 'OPENAI_API_KEY', scope: 'global' } });
    expect(result.isError).toBeFalsy();
    // No completion yet: the tool call returned before the human clicked Reveal.
    expect(completeNotification).toBeUndefined();

    const revealResp = await fetch(`${revealUrl}/reveal`, { method: 'POST' });
    expect(revealResp.status).toBe(200);

    await vi.waitFor(() => expect(completeNotification).toBeDefined());
    expect(completeNotification?.elicitationId).toBe(new URL(revealUrl!).pathname.split('/').pop());

    await pair.close();
  });

  it('decline/cancel: returns a cancelled status', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    pair.client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' }));

    const result = await pair.client.callTool({ name: 'enigma_reveal', arguments: { name: 'OPENAI_API_KEY', scope: 'global' } });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('cancelled');
    await pair.close();
  });

  it('without elicitation.url capability: returns request_id/url text, without calling elicitInput', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({ elicitation: {} });
    const handler = vi.fn();
    pair.client.setRequestHandler(ElicitRequestSchema, handler);

    const result = await pair.client.callTool({ name: 'enigma_reveal', arguments: { name: 'OPENAI_API_KEY', scope: 'global' } });

    expect(handler).not.toHaveBeenCalled();
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('request_id');
    expect(text).not.toContain(SENTINEL);
    await pair.close();
  });

  it('method:"clipboard" on darwin copies to the clipboard directly, without starting the HTTP server or elicitation', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    mockClipboardBinaries();

    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    const handler = vi.fn();
    pair.client.setRequestHandler(ElicitRequestSchema, handler);

    const result = await pair.client.callTool({
      name: 'enigma_reveal',
      arguments: { name: 'OPENAI_API_KEY', scope: 'global', method: 'clipboard' },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('Copied to clipboard; clears in 60 s');
    await pair.close();
  });

  it('method:"clipboard" off darwin returns E_UI_UNAVAILABLE', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({
      name: 'enigma_reveal',
      arguments: { name: 'OPENAI_API_KEY', method: 'clipboard' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_UI_UNAVAILABLE');
    await pair.close();
  });
});
