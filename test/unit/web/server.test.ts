import { afterEach, describe, expect, it, vi } from 'vitest';
import { __peekServerStateForTests, startServer, stopServer } from '../../../src/web/server.js';
import { RequestStore } from '../../../src/request/store.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('startServer', () => {
  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
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

  describe('idle timer never closes the server while a request is open (Issue #69 §3)', () => {
    afterEach(() => {
      RequestStore.__resetForTests();
      vi.useRealTimers();
    });

    it('a request created at t=0 keeps the server up past the idle boundary on the same port, until submit or expiry', async () => {
      // Idle timeout 100ms, request TTL 60s. The timer fires at t=100, the
      // open-record query says "request expiresAt = 60_000", so the timer
      // re-arms to max(1000, min(100, 60_000 - 100 + 1)) = 1000 ms (the
      // 1000ms floor is mandated by the issue's spec — AC #9, "always
      // positive" — to guard against any future relaxation of the strict-<
      // boundary). The server is still up at t=100 on the same port.
      // vi.useFakeTimers() (default — fakes Date too) is required here:
      // onIdleTimer calls Date.now(), and if Date stays real while setTimeout
      // is faked, the re-arm sees "still 60s away" forever and re-arms in a
      // tight loop.
      vi.useFakeTimers();
      try {
        const first = await startServer({ idleTimeoutMs: 100 });
        RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 60_000 });

        await vi.advanceTimersByTimeAsync(150);
        const samePort = await startServer({ idleTimeoutMs: 100 });
        expect(samePort.port).toBe(first.port);

        // Advance past the request's TTL by more than the re-arm floor
        // (1000ms) so the next re-armed timer actually fires inside the
        // advance range and the close can be observed. The server closes
        // within ~one re-arm interval past the request's expiry, which is
        // the literal reading of "within one idle interval" in AC #6 (the
        // re-arm interval is bounded by the re-arm formula in §3, which is
        // also the timer-callback path AC #6 names).
        await vi.advanceTimersByTimeAsync(61_000);
        const afterClose = await startServer({ idleTimeoutMs: 100 });
        expect(afterClose.port).not.toBe(first.port);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a used-but-in-grace record does NOT count as open — the server still closes at the idle timeout', async () => {
      vi.useFakeTimers();
      try {
        const first = await startServer({ idleTimeoutMs: 100 });
        const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 60_000 });
        RequestStore.tryMarkUsed(record.id);

        await vi.advanceTimersByTimeAsync(150);
        const afterClose = await startServer({ idleTimeoutMs: 100 });
        expect(afterClose.port).not.toBe(first.port);
      } finally {
        vi.useRealTimers();
      }
    });

    it('boundary: at now === expiresAt the timer re-arms with a positive delay (does not spin) and closes once now exceeds expiresAt (PR #78 review, finding 1)', async () => {
      vi.useFakeTimers();
      try {
        const first = await startServer({ idleTimeoutMs: 100 });
        // TTL equals the idle timeout so the idle timer's first fire lands
        // exactly at now === expiresAt — the boundary the Tech Lead ruled
        // on: open := !isExpired(record, now), i.e. now <= expiresAt still
        // works. No startServer()/fetch() call happens before that first
        // fire — either would call resetIdleTimer and mask whether
        // onIdleTimer's own re-arm logic actually ran.
        RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 100 });

        // t=100: the timer fires exactly at now === expiresAt. The record
        // is still open at that instant, so onIdleTimer re-arms rather than
        // closing — observed via the side-effect-free peek hook, not a
        // startServer()/fetch() call.
        await vi.advanceTimersByTimeAsync(100);
        expect(__peekServerStateForTests()?.port).toBe(first.port);

        // The re-arm delay at that instant is (expiresAt - now + 1) = 1ms,
        // floored to MIN_REARM_DELAY_MS = 1000ms, so the next fire is at
        // t=1100. By then now (1100) > expiresAt (100): the record is no
        // longer open and the server closes.
        await vi.advanceTimersByTimeAsync(1000);
        expect(__peekServerStateForTests()).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('AC6: production defaults (10 min idle / 15 min TTL) — the server stays up past the idle window on the ORIGINAL port while a request is open, then closes once past expiry (PR #78 review, finding 3)', async () => {
      vi.useFakeTimers();
      try {
        // No idleTimeoutMs/ttlMs override: exercises the real production
        // defaults (DEFAULT_IDLE_TIMEOUT_MS = 10 min, REQUEST_TTL_MS = 15
        // min), not a scaled-down stand-in.
        const first = await startServer();
        const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

        // Past the 10-minute idle window, with no startServer() call in
        // between resetting the timer — proves onIdleTimer's own re-arm
        // logic, driven by earliestOpenExpiry, is what keeps it up.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
        expect(__peekServerStateForTests()?.port).toBe(first.port);

        // Fetch both routes on the ORIGINAL origin/port to prove liveness
        // through the real HTTP surface, not just the peek hook.
        const formResp = await fetch(`${first.origin}/r/${record.id}`);
        expect(formResp.status).toBe(200);
        const statusResp = await fetch(`${first.origin}/r/${record.id}/status`);
        expect(statusResp.status).toBe(200);
        await expect(statusResp.json()).resolves.toEqual({ state: 'pending' });

        // Those two fetches reset the idle timer to a fresh 10-minute
        // window (the existing per-request-reset behavior), so advance
        // generously past both the request's 15-minute TTL AND a further
        // full idle window from that reset point to guarantee the close
        // fires regardless of exactly when the last reset landed.
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10 * 60 * 1000);
        expect(__peekServerStateForTests()).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('explicit stopServer closes even while an open record exists', async () => {
      vi.useFakeTimers();
      try {
        const first = await startServer({ idleTimeoutMs: 100 });
        RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 60_000 });

        await stopServer();
        const afterClose = await startServer({ idleTimeoutMs: 100 });
        expect(afterClose.port).not.toBe(first.port);
      } finally {
        vi.useRealTimers();
      }
    });

    it('the HTTP per-request reset still uses idleTimeoutMs when no records are open (existing behavior preserved)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const first = await startServer({ idleTimeoutMs: 100 });
        await vi.advanceTimersByTimeAsync(80);
        await fetch(`${first.origin}/healthz`);
        await vi.advanceTimersByTimeAsync(90);
        const stillRunning = await startServer({ idleTimeoutMs: 100 });
        expect(stillRunning.port).toBe(first.port);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
