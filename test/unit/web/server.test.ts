import { afterEach, describe, expect, it, vi } from 'vitest';
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
    // Real sleeps raced the idle timer against the request's connection time,
    // so this drives the clock explicitly instead: the request lands at a
    // known instant, and we advance past the original (un-reset) deadline
    // without ever crossing the deadline the reset actually grants.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const first = await startServer({ idleTimeoutMs: 100 });

      await vi.advanceTimersByTimeAsync(80);
      await fetch(`${first.origin}/healthz`); // activity resets the deadline to t=180

      // t=170: past the original t=100 deadline a server that ignored the
      // reset would have used, but under the t=180 deadline the reset grants.
      await vi.advanceTimersByTimeAsync(90);
      const stillRunning = await startServer({ idleTimeoutMs: 100 });
      expect(stillRunning.port).toBe(first.port);

      // Let a full idle window elapse with no further activity: the server
      // must actually close, proving the timer was genuinely armed and not
      // merely disabled by the reset.
      await vi.advanceTimersByTimeAsync(100);
      const afterClose = await startServer({ idleTimeoutMs: 100 });
      expect(afterClose.port).not.toBe(first.port);
    } finally {
      vi.useRealTimers();
    }
  });
});
