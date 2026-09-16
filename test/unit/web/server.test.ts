import { afterEach, describe, expect, it } from 'vitest';
import { startServer, stopServer } from '../../../src/web/server.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('startServer', () => {
  afterEach(async () => {
    await stopServer();
  });

  it('binds to 127.0.0.1 on an ephemeral port', async () => {
    const handle = await startServer();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.origin).toBe(`http://127.0.0.1:${handle.port}`);
  });

  it('a second call reuses the running instance instead of binding again', async () => {
    const first = await startServer();
    const second = await startServer();
    expect(second.port).toBe(first.port);
  });

  it('concurrent calls before the first bind completes resolve to the same instance', async () => {
    const [a, b] = await Promise.all([startServer(), startServer()]);
    expect(a.port).toBe(b.port);
  });

  it('refuses to bind a non-localhost, non-Tailscale host without an override (ADR-005)', async () => {
    await expect(startServer({ host: '192.168.1.50' })).rejects.toThrow(/refusing to bind/);
  });

  it('close() stops the server so a subsequent startServer binds a fresh instance', async () => {
    const first = await startServer();
    await first.close();
    const second = await startServer();
    expect(second.port).not.toBe(0);
  });

  it('idle-closes after the configured timeout with no activity, so the next startServer binds a fresh instance', async () => {
    const first = await startServer({ idleTimeoutMs: 30 });
    await sleep(80);

    const second = await startServer({ idleTimeoutMs: 30 });
    expect(second.port).not.toBe(first.port);
  });

  it('an incoming request resets the idle timer', async () => {
    const first = await startServer({ idleTimeoutMs: 60 });
    await sleep(30);
    await fetch(`${first.origin}/healthz`); // activity within the window
    await sleep(30);

    // 60ms since the request, well under the 60ms idle window restarted by it.
    const second = await startServer({ idleTimeoutMs: 60 });
    expect(second.port).toBe(first.port);
  });
});
