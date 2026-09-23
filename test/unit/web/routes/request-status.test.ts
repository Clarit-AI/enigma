import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startServer, stopServer } from '../../../../src/web/server.js';
import { RequestStore } from '../../../../src/request/store.js';

/**
 * Drives `setSecret` through a deferred promise so the per-name write loop
 * in `handleRequestFormPost` is held open across a status poll — proves
 * AC #4 ("writes delayed after tryMarkUsed → status stays pending, flips
 * to fulfilled only once results are recorded") through the real handler,
 * not just through direct `RequestStore.fulfill` calls. The mock passes
 * every other export of `src/storage/manager.js` through to the real
 * module so `renderForm` (the GET /r/:id path) and the picker still work.
 *
 * `vi.hoisted` is required because the mock factory runs at hoist time
 * (before module-scope lets are populated), so the deferred has to be
 * declared through `vi.hoisted` to be reachable from both the factory
 * and the test bodies.
 */
const setSecretDeferred = vi.hoisted(() => {
  interface Deferred {
    promise: Promise<{ rotated: boolean; warnings: string[] }>;
    resolve: () => void;
  }
  let current: Deferred = pending();
  function pending(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<{ rotated: boolean; warnings: string[] }>((res) => {
      resolve = () => res({ rotated: false, warnings: [] });
    });
    return { promise, resolve };
  }
  return {
    /** Awaited by the mock — resolves to a successful setSecret result. */
    get promise(): Promise<{ rotated: boolean; warnings: string[] }> {
      return current.promise;
    },
    /** Test helper: release the deferred so the POST handler completes. */
    resolve(): void {
      current.resolve();
      current = pending();
    },
    /** `beforeEach` helper: discard any leftover deferred from a previous test. */
    reset(): void {
      current = pending();
    },
  };
});

vi.mock('../../../../src/storage/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/storage/manager.js')>();
  return {
    ...actual,
    setSecret: vi.fn(async () => setSecretDeferred.promise),
  };
});

const { setSecret } = await import('../../../../src/storage/manager.js');

describe('GET /r/:id/status (Issue #69 §1)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let origin: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();
    setSecretDeferred.reset();
    origin = (await startServer()).origin;
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('GET /r/<id>/status for a pending request returns 200 {"state":"pending"}', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}/status`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ state: 'pending' });
  });

  it('after fulfill the same id returns 200 {"state":"fulfilled"}', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);
    const resp = await fetch(`${origin}/r/${record.id}/status`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ state: 'fulfilled' });
  });

  it('an unknown id returns 404', async () => {
    const resp = await fetch(`${origin}/r/${'a'.repeat(32)}/status`);
    expect(resp.status).toBe(404);
  });

  it('an expired id returns 404', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: -1 });
    const resp = await fetch(`${origin}/r/${record.id}/status`);
    expect(resp.status).toBe(404);
  });

  it('a kind "reveal" id at this path returns 404 — the route only answers for kind "request" (amendment #3)', async () => {
    const record = RequestStore.create({ kind: 'reveal', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}/status`);
    expect(resp.status).toBe(404);
  });

  it('a kind "import" id at this path returns 404 — the route only answers for kind "request" (amendment #3)', async () => {
    const record = RequestStore.create({ kind: 'import', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}/status`);
    expect(resp.status).toBe(404);
  });

  it('a malformed (non-32-hex) id returns 404 (regex enforces shape)', async () => {
    const resp = await fetch(`${origin}/r/not-a-valid-id/status`);
    expect(resp.status).toBe(404);
  });

  it('a path with extra suffix returns 404 (regex anchored with $)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}/status/extra`);
    expect(resp.status).toBe(404);
  });

  it('a path with the wrong case returns 404 (regex is case-sensitive)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}/Status`);
    expect(resp.status).toBe(404);
  });

  it('POST is not allowed on the status path — falls through to existing 404', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}/status`, { method: 'POST' });
    expect(resp.status).toBe(404);
  });

  it('the status body never contains names or values (AC #3)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'] });
    const resp = await fetch(`${origin}/r/${record.id}/status`);
    const body = await resp.text();
    expect(body).not.toContain('OPENAI_API_KEY');
    expect(body).not.toContain('GITHUB_TOKEN');
    expect(body).not.toContain(record.id);
  });

  it('calling /status does not consume the outcome: listUnconsumedFulfilled still lists the id (AC #3)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    expect(RequestStore.listUnconsumedFulfilled()).toHaveLength(1);
    await fetch(`${origin}/r/${record.id}/status`);
    await fetch(`${origin}/r/${record.id}/status`);
    await fetch(`${origin}/r/${record.id}/status`);
    expect(RequestStore.listUnconsumedFulfilled()).toHaveLength(1);
  });

  it('AC #4 — through the real POST handler: status is "pending" while setSecret is held open, then "fulfilled" once released', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    // Fire the POST without awaiting — the handler enters its per-name
    // setSecret loop and parks on our deferred, so fulfill never runs and
    // results stays undefined while we poll /status.
    const postPromise = fetch(`${origin}/r/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ OPENAI_API_KEY: 'value', depository: 'encrypted', scope: 'global' }).toString(),
    });

    // Waits for the handler to actually reach setSecret rather than
    // assuming a fixed tick count — a fixed-tick delay (PR #78 review,
    // finding 5) is exactly what made this test flaky under a full
    // parallel `npm test` run: detectAll() and needsCreateVaultConfirmation()
    // both do real, variable-latency async work ahead of setSecret, so the
    // number of ticks needed isn't constant under load.
    await vi.waitFor(() => expect(setSecret).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const recordDuring = RequestStore.get(record.id);
    expect(recordDuring?.usedAt).toBeDefined();
    expect(recordDuring?.results).toBeUndefined();

    const pending = await fetch(`${origin}/r/${record.id}/status`);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ state: 'pending' });

    // Release the deferred — setSecret resolves, the per-name loop appends
    // its result, RequestStore.fulfill runs, the POST returns the done page.
    setSecretDeferred.resolve();
    const postResp = await postPromise;
    expect(postResp.status).toBe(200);

    const fulfilled = await fetch(`${origin}/r/${record.id}/status`);
    expect(fulfilled.status).toBe(200);
    expect(await fulfilled.json()).toEqual({ state: 'fulfilled' });
  });

  it('the status response carries the same security headers as other routes (Cache-Control: no-store, X-Frame-Options, Referrer-Policy)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}/status`);
    expect(resp.headers.get('cache-control')).toBe('no-store');
    expect(resp.headers.get('x-frame-options')).toBe('DENY');
    expect(resp.headers.get('referrer-policy')).toBe('no-referrer');
    expect(resp.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    );
  });
});