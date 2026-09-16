import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, stopServer } from '../../../src/web/server.js';
import { RequestStore } from '../../../src/request/store.js';

describe('router', () => {
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

  it('returns 404 for a path that matches no route', async () => {
    const resp = await fetch(`${origin}/nope`);
    expect(resp.status).toBe(404);
  });

  it('returns 404 for a malformed (non-32-hex) request id', async () => {
    const resp = await fetch(`${origin}/r/not-a-valid-id`);
    expect(resp.status).toBe(404);
  });

  it('returns 404 for an unsupported method on a known path shape', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/r/${record.id}`, { method: 'DELETE' });
    expect(resp.status).toBe(404);
  });

  it('serves /static/reveal.js as JavaScript', async () => {
    const resp = await fetch(`${origin}/static/reveal.js`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('javascript');
    expect(await resp.text()).toContain('revealBtn');
  });
});
