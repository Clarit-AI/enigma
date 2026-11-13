// Issue #142: when the client can't show the form, the agent must SEND the link before blocking on enigma_await.
// The fallback results say so, and enigma_await gives the turn back (with the link) if the link is never opened.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectWithCapabilities } from './harness.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { DEFAULT_OPEN_GRACE_MS, __setAwaitOpenGraceForTesting } from '../../../src/mcp/tools/await.js';
import { RequestStore } from '../../../src/request/store.js';
import { setSecret } from '../../../src/storage/manager.js';
import { stopServer } from '../../../src/web/server.js';

const textOf = (result: unknown): string => ((result as { content?: Array<{ text: string }> }).content ?? [])[0]?.text ?? '';
const firstJson = (text: string): Record<string, unknown> => JSON.parse(text.split('\n')[0]!) as Record<string, unknown>;
const RELAY_LEAD = 'The user cannot see this link until you send it. Put it in your reply to the user now, then end your turn.';
const REQUEST_ARGS = { names: ['GITHUB_TOKEN'], reason: 'test', usage: 'interactive', scope: 'global', depository: 'encrypted' } as const;

describe('Issue #142: relaying the link before awaiting', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let project: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    project = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(project, '.git'));
    originalCwd = process.cwd();
    process.chdir(project);
    RequestStore.__resetForTests();
    __setAwaitOpenGraceForTesting({ graceMs: 300, pollMs: 10 });
  });

  afterEach(async () => {
    __setAwaitOpenGraceForTesting({ graceMs: DEFAULT_OPEN_GRACE_MS, pollMs: 250 });
    await stopServer();
    RequestStore.__resetForTests();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('the open-grace wait ends well before a default MCP client gives up on the call (PR #144 review)', () => {
    // The client's timer starts before ours and the pending result still has to travel back: at 60 s the client
    // timed out first and the agent got -32001 instead of the link. Keep at least 10 s of margin.
    expect(DEFAULT_OPEN_GRACE_MS + 10_000).toBeLessThanOrEqual(DEFAULT_REQUEST_TIMEOUT_MSEC);
  });

  describe('fallback results lead with the relay instruction, the URL on its own line', () => {
    it('enigma_request, client without URL-mode elicitation', async () => {
      const pair = await connectWithCapabilities({});
      const text = textOf(await pair.client.callTool({ name: 'enigma_request', arguments: REQUEST_ARGS }));
      const lines = text.split('\n');
      const url = firstJson(text).url as string;
      expect(lines[1]).toBe(RELAY_LEAD);
      expect(lines[2]).toBe(`Link for the user: ${url}`);
      expect(lines[3]).toBe('Call enigma_await with this request_id only after the user says they have submitted the form.');
      expect(text).toContain('does not support URL-mode elicitation');
      expect(RequestStore.get(firstJson(text).request_id as string)?.relayLink).toBe(url);
      await pair.close();
    });

    it('enigma_request, client that advertises elicitation but declines (Issue #118 path)', async () => {
      const pair = await connectWithCapabilities({ elicitation: { url: {} } });
      pair.client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));
      const text = textOf(await pair.client.callTool({ name: 'enigma_request', arguments: REQUEST_ARGS }));
      const lines = text.split('\n');
      expect(lines[1]).toBe(RELAY_LEAD);
      expect(lines[2]).toBe(`Link for the user: ${firstJson(text).url as string}`);
      expect(text).toContain('declined the URL elicitation');
      expect(text).toContain('ui:"native"');
      await pair.close();
    });

    it('enigma_import, client without URL-mode elicitation', async () => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(project, '.env'), 'API_KEY=x\n');
      const pair = await connectWithCapabilities({});
      const text = textOf(await pair.client.callTool({ name: 'enigma_import', arguments: { path: '.env' } }));
      const lines = text.split('\n');
      expect(lines[1]).toBe(RELAY_LEAD);
      expect(lines[2]).toBe(`Link for the user: ${firstJson(text).url as string}`);
      expect(lines[3]).toBe('Call enigma_await with this request_id only after the user says they have chosen a depository.');
      await pair.close();
    });

    it('enigma_reveal, client without URL-mode elicitation (no await follows)', async () => {
      await setSecret({ name: 'GITHUB_TOKEN', value: 'sk-never-shown', scope: 'global', depository: 'encrypted', actor: 'cli' });
      const pair = await connectWithCapabilities({});
      const text = textOf(await pair.client.callTool({ name: 'enigma_reveal', arguments: { name: 'GITHUB_TOKEN', scope: 'global' } }));
      const lines = text.split('\n');
      expect(lines[1]).toBe(RELAY_LEAD);
      expect(lines[2]).toBe(`Link for the user: ${firstJson(text).url as string}`);
      expect(lines[3]).toBe('The user opens it to reveal GITHUB_TOKEN; nothing comes back to you.');
      expect(text).not.toContain('sk-never-shown');
      await pair.close();
    });
  });

  describe('enigma_await on a relayed link', () => {
    async function requestViaFallback(pair: Awaited<ReturnType<typeof connectWithCapabilities>>): Promise<{ id: string; url: string }> {
      const json = firstJson(textOf(await pair.client.callTool({ name: 'enigma_request', arguments: REQUEST_ARGS })));
      return { id: json.request_id as string, url: json.url as string };
    }

    it('never opened: returns pending with the link after the grace period; nothing consumed; a later await gets the outcome', async () => {
      const pair = await connectWithCapabilities({});
      const { id, url } = await requestViaFallback(pair);

      const started = Date.now();
      const pending = await pair.client.callTool({ name: 'enigma_await', arguments: { request_id: id } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(pending.isError).toBeFalsy();
      const text = textOf(pending);
      expect(firstJson(text)).toEqual({ request_id: id, state: 'pending', url, expiresAt: expect.any(String) });
      expect(text).toContain('The user has not opened the link yet');
      expect(text).toContain(`Link for the user: ${url}`);
      expect(text).not.toContain('GITHUB_TOKEN'); // names-free
      expect(RequestStore.get(id)?.usedAt).toBeUndefined();

      // The user now opens and submits; the next await returns the real outcome.
      await fetch(url);
      const later = pair.client.callTool({ name: 'enigma_await', arguments: { request_id: id } });
      RequestStore.tryMarkUsed(id);
      RequestStore.fulfill(id, [{ name: 'GITHUB_TOKEN', ok: true }]);
      expect(textOf(await later)).not.toContain('"state":"pending"');
      await pair.close();
    });

    it('opened during the grace period: keeps blocking and returns the outcome', async () => {
      __setAwaitOpenGraceForTesting({ graceMs: 2_000, pollMs: 10 });
      const pair = await connectWithCapabilities({});
      const { id, url } = await requestViaFallback(pair);

      const call = pair.client.callTool({ name: 'enigma_await', arguments: { request_id: id } });
      await new Promise((r) => setTimeout(r, 100));
      expect((await fetch(url)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 2_100)); // well past the grace period: still blocked
      RequestStore.tryMarkUsed(id);
      RequestStore.fulfill(id, [{ name: 'GITHUB_TOKEN', ok: false, errorCode: 'E_MISSING_VALUE' }]);
      const text = textOf(await call);
      expect(text).not.toContain('"state":"pending"');
      expect(text).toContain('GITHUB_TOKEN');
      await pair.close();
    });

    it('the status poll does not count as opening the link', async () => {
      const pair = await connectWithCapabilities({});
      const { id, url } = await requestViaFallback(pair);
      expect((await fetch(`${url}/status`)).status).toBe(200);
      expect(RequestStore.get(id)?.openedAt).toBeUndefined();
      expect(firstJson(textOf(await pair.client.callTool({ name: 'enigma_await', arguments: { request_id: id } }))).state).toBe('pending');
      await pair.close();
    });

    it('a request with no relayed link (created outside a fallback) blocks as before', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['GITHUB_TOKEN'] });
      const pair = await connectWithCapabilities({});
      const call = pair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });
      await new Promise((r) => setTimeout(r, 500)); // past the 300 ms grace
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [{ name: 'GITHUB_TOKEN', ok: false, errorCode: 'E_MISSING_VALUE' }]);
      expect(textOf(await call)).not.toContain('"state":"pending"');
      await pair.close();
    });

    it('an expired relayed request still returns E_REQUEST_EXPIRED', async () => {
      const pair = await connectWithCapabilities({});
      const { id } = await requestViaFallback(pair);
      RequestStore.get(id)!.expiresAt = Date.now() - 1;
      const result = await pair.client.callTool({ name: 'enigma_await', arguments: { request_id: id } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('E_REQUEST_EXPIRED');
      await pair.close();
    });
  });

  it('GET /i/:id records the import as opened', async () => {
    const { startServer } = await import('../../../src/web/server.js');
    const { origin } = await startServer();
    const record = RequestStore.create({ kind: 'import', names: ['API_KEY'], values: { API_KEY: 'x' }, envFilePath: join(project, '.env') });
    expect((await fetch(`${origin}/i/${record.id}`)).status).toBe(200);
    expect(RequestStore.get(record.id)?.openedAt).toEqual(expect.any(Number));
  });
});
