import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `1password` depository these routes can now select is a real external
 * CLI (`op`), unlike the other depositories this file exercises. Mocking
 * `child_process` to always fail with ENOENT keeps the whole file
 * deterministic — identical on a Linux CI box with no `op`, this signed-out
 * Mac, or a contributor's signed-in laptop — rather than depending on
 * whatever state happens to be installed on the machine running the suite.
 */
vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as EventEmitter & { write: (d: string) => boolean; end: () => void };
    stdin.write = () => true;
    stdin.end = () => {};
    const error = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
    queueMicrotask(() => callback(error, '', ''));
    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const { startServer, stopServer } = await import('../../../../src/web/server.js');
const { RequestStore } = await import('../../../../src/request/store.js');
const { setSecret } = await import('../../../../src/storage/manager.js');
const { registerActiveTunnel } = await import('../../../../src/remote/index.js');

describe('GET/POST /r/:id', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let origin: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();
    origin = (await startServer()).origin;
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('GET returns 404 for an unknown id', async () => {
    const resp = await fetch(`${origin}/r/${'a'.repeat(32)}`);
    expect(resp.status).toBe(404);
  });

  it('GET returns 404 for a reveal-kind id (route/kind mismatch)', async () => {
    const record = RequestStore.create({ kind: 'reveal', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}`);
    expect(resp.status).toBe(404);
  });

  it('GET returns 410 once the id has been used', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);

    const resp = await fetch(`${origin}/r/${record.id}`);
    expect(resp.status).toBe(410);
  });

  it('GET renders the depository picker with prompt-profile labels and the requested name', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], reason: 'testing' });
    const resp = await fetch(`${origin}/r/${record.id}`);
    const html = await resp.text();

    expect(html).toContain('OPENAI_API_KEY');
    expect(html).toContain('encrypted (no prompt)');
    expect(html).toContain('testing');
  });

  it(
    'GET marks an unavailable depository disabled and states why, instead of hiding it (Issue #61: ' +
      '"a control that overstates itself is worse than one that states its limits")',
    async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      const resp = await fetch(`${origin}/r/${record.id}`);
      const html = await resp.text();

      // 1password is always unavailable in this file's op-ENOENT mock (op CLI not
      // installed) — it must still be listed, just disabled with its reason appended.
      expect(html).toContain('1password');
      const optionMatch = html.match(/<option value="1password"[^>]*>([^<]*)<\/option>/);
      expect(optionMatch, 'expected a 1password <option> in the rendered form').not.toBeNull();
      const optionTag = html.slice(html.indexOf('<option value="1password"'), html.indexOf('</option>', html.indexOf('<option value="1password"')));
      expect(optionTag).toContain('disabled');
      expect(optionMatch![1]).toContain('unavailable: op CLI not installed');

      // An available depository (encrypted) must stay enabled and unsuffixed.
      const encryptedTag = html.slice(html.indexOf('<option value="encrypted"'), html.indexOf('</option>', html.indexOf('<option value="encrypted"')));
      expect(encryptedTag).not.toContain('disabled');
      expect(encryptedTag).not.toContain('unavailable');
    },
  );

  it('POST without a chosen depository re-renders the form with an error, id stays usable', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ OPENAI_API_KEY: 'value' }).toString(),
    });

    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('Choose a depository');
    expect(RequestStore.get(record.id)?.usedAt).toBeUndefined();
  });

  it('POST with an unavailable depository re-renders the confirmation without consuming the id', async () => {
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
  });

  it('POST with confirmCreateVault set still records the write failure via per-name results, without crashing (AC5, D4)', async () => {
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
    expect(html).toContain('failed');
    // Issue #61: the failure page now names the depository and reason, not just the
    // bare error code, threaded from EnigmaError.message (value-free by construction —
    // see the reason-field-surfaces.test.ts golden set this comes from).
    expect(html).toContain('failed to write secret to 1password depository');
    expect(RequestStore.get(record.id)?.usedAt).toBeDefined();
    expect(RequestStore.get(record.id)?.results).toEqual([
      {
        name: 'OPENAI_API_KEY',
        ok: false,
        errorCode: 'E_WRITE_FAILED',
        reason: 'failed to write secret to 1password depository',
      },
    ]);
  });

  it(
    'a value submitted for a name that then fails to write never appears in the failure reason text ' +
      '(sentinel for test/unit/reason-field-surfaces.test.ts — Issue #38/#61)',
    async () => {
      const SENTINEL = 'sk-plant-should-never-appear-in-reason';
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      const resp = await fetch(`${origin}/r/${record.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          OPENAI_API_KEY: SENTINEL,
          depository: '1password',
          scope: 'global',
          confirmCreateVault: 'on',
        }).toString(),
      });

      const html = await resp.text();
      expect(html).not.toContain(SENTINEL);
      expect(RequestStore.get(record.id)?.results?.[0]?.reason).not.toContain(SENTINEL);
    },
  );

  it('GET shows no QR code when no tunnel is active for this request (Issue #12 AC4)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}`);
    const html = await resp.text();
    expect(html).not.toContain('<svg');
  });

  it('GET shows a QR code of the active tunnel URL when one is up for this request (Issue #12 AC4)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    registerActiveTunnel(record.id, {
      tunnel: {
        url: 'https://qr-test.trycloudflare.com',
        binary: 'cloudflared',
        stop: () => {},
        waitForUnexpectedExit: () => new Promise(() => {}),
      },
    });

    const resp = await fetch(`${origin}/r/${record.id}`);
    const html = await resp.text();
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox=');

    // The QR encodes the URL as geometry, not literal text — confirm it's
    // actually derived from this request's tunnel URL (and not some fixed
    // placeholder) by checking a different active URL renders differently.
    const otherRecord = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    registerActiveTunnel(otherRecord.id, {
      tunnel: {
        url: 'https://a-totally-different-host.trycloudflare.com',
        binary: 'cloudflared',
        stop: () => {},
        waitForUnexpectedExit: () => new Promise(() => {}),
      },
    });
    const otherHtml = await (await fetch(`${origin}/r/${otherRecord.id}`)).text();
    const svgOf = (page: string): string => page.slice(page.indexOf('<svg'), page.indexOf('</svg>') + '</svg>'.length);
    expect(svgOf(html)).not.toBe(svgOf(otherHtml));
  });

  it('GET shows a rotate warning when the name already exists', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'old-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], scope: 'global' });

    const resp = await fetch(`${origin}/r/${record.id}`);
    expect(await resp.text()).toContain('already exists and will be rotated');
  });

  it('replaying a used id returns 410 and performs no second write', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], scope: 'global' });
    await fetch(`${origin}/r/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ OPENAI_API_KEY: 'first-value', depository: 'encrypted', scope: 'global' }).toString(),
    });

    const replay = await fetch(`${origin}/r/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ OPENAI_API_KEY: 'second-value', depository: 'encrypted', scope: 'global' }).toString(),
    });

    expect(replay.status).toBe(410);
  });
});
