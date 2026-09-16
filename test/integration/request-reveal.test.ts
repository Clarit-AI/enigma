import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, stopServer } from '../../src/web/server.js';
import { RequestStore } from '../../src/request/store.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

describe('request/reveal integration, against the real server', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let origin: string;
  const logged: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();

    logged.length = 0;
    const capture = (chunk: unknown): boolean => {
      logged.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logged.push(args.map(String).join(' '));
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logged.push(args.map(String).join(' '));
    });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(capture);

    const handle = await startServer();
    origin = handle.origin;
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it(
    'a sentinel submitted through /r/:id appears in no response body except POST /v/:id/reveal, and in no log line (S2.4)',
    async () => {
      const requestRecord = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

      const getForm = await fetch(`${origin}/r/${requestRecord.id}`);
      const formHtml = await getForm.text();
      expect(getForm.status).toBe(200);
      expect(formHtml).not.toContain(SENTINEL);

      const postResp = await fetch(`${origin}/r/${requestRecord.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ OPENAI_API_KEY: SENTINEL, depository: 'encrypted', scope: 'global' }).toString(),
      });
      const doneHtml = await postResp.text();
      expect(postResp.status).toBe(200);
      expect(doneHtml).not.toContain(SENTINEL);
      expect(doneHtml).toContain('stored');

      const replay = await fetch(`${origin}/r/${requestRecord.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'OPENAI_API_KEY=some-other-value',
      });
      expect(replay.status).toBe(410);

      const revealRecord = RequestStore.create({ kind: 'reveal', names: ['OPENAI_API_KEY'] });

      const getShell = await fetch(`${origin}/v/${revealRecord.id}`);
      const shellHtml = await getShell.text();
      expect(getShell.status).toBe(200);
      expect(shellHtml).not.toContain(SENTINEL);

      const revealResp = await fetch(`${origin}/v/${revealRecord.id}/reveal`, { method: 'POST' });
      expect(revealResp.status).toBe(200);
      const revealBody = (await revealResp.json()) as { name: string; value: string };
      expect(revealBody).toEqual({ name: 'OPENAI_API_KEY', value: SENTINEL });

      const revealReplay = await fetch(`${origin}/v/${revealRecord.id}/reveal`, { method: 'POST' });
      expect(revealReplay.status).toBe(410);
      const revealReplayText = await revealReplay.text();
      expect(revealReplayText).not.toContain(SENTINEL);

      expect(logged.join('\n')).not.toContain(SENTINEL);
    },
  );

  it('expired reveal id returns 404 and never resolves a value', async () => {
    const record = RequestStore.create({ kind: 'reveal', names: ['OPENAI_API_KEY'], ttlMs: -1 });

    const resp = await fetch(`${origin}/v/${record.id}/reveal`, { method: 'POST' });
    expect(resp.status).toBe(404);
  });

  it('unknown request id returns 404', async () => {
    const resp = await fetch(`${origin}/r/${'0'.repeat(32)}`);
    expect(resp.status).toBe(404);
  });

  it('a submission over 64KB returns 413', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const bigValue = 'a'.repeat(70 * 1024);

    const resp = await fetch(`${origin}/r/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `OPENAI_API_KEY=${bigValue}`,
    });
    expect(resp.status).toBe(413);
  });

  it('every response carries the required security headers, including /static/*', async () => {
    for (const path of ['/healthz', '/static/reveal.js']) {
      const resp = await fetch(`${origin}${path}`);
      expect(resp.headers.get('content-security-policy')).toBe("default-src 'self'; script-src 'self'");
      expect(resp.headers.get('x-frame-options')).toBe('DENY');
      expect(resp.headers.get('referrer-policy')).toBe('no-referrer');
      expect(resp.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('GET /healthz reports liveness', async () => {
    const resp = await fetch(`${origin}/healthz`);
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ ok: true });
  });

  it('startServer reuses the running instance on a second call', async () => {
    const again = await startServer();
    expect(again.origin).toBe(origin);
  });
});
