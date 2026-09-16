import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestStore } from '../../../src/request/store.js';

describe('RequestStore', () => {
  beforeEach(() => {
    RequestStore.__resetForTests();
  });

  afterEach(() => {
    RequestStore.__resetForTests();
    vi.useRealTimers();
  });

  it('create returns a 32-hex id', () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    expect(record.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a reveal that does not cover exactly one name', () => {
    expect(() => RequestStore.create({ kind: 'reveal', names: [] })).toThrow();
    expect(() => RequestStore.create({ kind: 'reveal', names: ['A', 'B'] })).toThrow();
  });

  it('rejects a request with zero or more than 10 names', () => {
    expect(() => RequestStore.create({ kind: 'request', names: [] })).toThrow();
    expect(() =>
      RequestStore.create({ kind: 'request', names: Array.from({ length: 11 }, (_, i) => `NAME_${i}`) }),
    ).toThrow();
  });

  it('get returns undefined for an unknown id', () => {
    expect(RequestStore.get('deadbeefdeadbeefdeadbeefdeadbeef')).toBeUndefined();
  });

  it('tryMarkUsed is atomic: the second call for the same id returns undefined', () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });

    const first = RequestStore.tryMarkUsed(record.id);
    const second = RequestStore.tryMarkUsed(record.id);

    expect(first?.id).toBe(record.id);
    expect(second).toBeUndefined();
  });

  it('tryMarkUsed alone does NOT resolve the waiter — marking a token used and reporting its outcome are two different moments', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const waiter = RequestStore.waitForFulfilled(record.id);
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });

    RequestStore.tryMarkUsed(record.id);
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);

    // Clean up the still-pending waiter so it doesn't leak into other tests.
    RequestStore.fulfill(record.id, []);
    await waiter;
  });

  it('fulfill resolves the waiter, and results are already readable at the moment it resolves — not merely afterwards', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);
    const waiter = RequestStore.waitForFulfilled(record.id);

    const assertion = waiter.then(() => {
      // Read from inside the resolution, not after both calls have already
      // happened regardless — this is what would catch fulfill resolving
      // before it finishes recording results.
      expect(RequestStore.get(record.id)?.results).toEqual([{ name: 'OPENAI_API_KEY', ok: true }]);
    });

    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    await assertion;
  });

  it('waitForFulfilled resolves immediately when fulfill has already run — the fast path does not fire on tryMarkUsed alone', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);

    // Between tryMarkUsed and fulfill, the fast path must not resolve early.
    const midWaiter = RequestStore.waitForFulfilled(record.id);
    let midSettled = false;
    void midWaiter.then(() => {
      midSettled = true;
    });
    await Promise.resolve();
    expect(midSettled).toBe(false);

    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);
    await expect(midWaiter).resolves.toBe('fulfilled');

    // After fulfill, a fresh call takes the fast path.
    await expect(RequestStore.waitForFulfilled(record.id)).resolves.toBe('fulfilled');
  });

  it('waitForFulfilled rejects for an unknown id', async () => {
    await expect(RequestStore.waitForFulfilled('deadbeefdeadbeefdeadbeefdeadbeef')).rejects.toThrow();
  });

  it('fulfill records per-name outcomes, readable via get, and defaults results to [] (used by a reveal, which has none)', () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    expect(RequestStore.get(record.id)?.results).toEqual([{ name: 'OPENAI_API_KEY', ok: true }]);

    const reveal = RequestStore.create({ kind: 'reveal', names: ['GITHUB_TOKEN'] });
    RequestStore.tryMarkUsed(reveal.id);
    RequestStore.fulfill(reveal.id);

    expect(RequestStore.get(reveal.id)?.results).toEqual([]);
  });

  describe('expiry and the sweeper', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('get returns undefined once an unused record expires', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 1000 });
      vi.advanceTimersByTime(1001);

      expect(RequestStore.get(record.id)).toBeUndefined();
    });

    it('tryMarkUsed on an expired id returns undefined', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 1000 });
      vi.advanceTimersByTime(1001);

      expect(RequestStore.tryMarkUsed(record.id)).toBeUndefined();
    });

    it('the sweeper rejects an outstanding waiter once its record expires', async () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 1000 });
      const waiter = RequestStore.waitForFulfilled(record.id);
      const assertion = expect(waiter).rejects.toThrow();

      vi.advanceTimersByTime(61_000);
      await assertion;
    });

    it('get still returns a used record within the grace period, even past its original TTL', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 1000 });
      RequestStore.tryMarkUsed(record.id);
      vi.advanceTimersByTime(2000);

      expect(RequestStore.get(record.id)?.id).toBe(record.id);
    });

    it('the sweeper removes a used record after the grace period elapses', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 1000 });
      RequestStore.tryMarkUsed(record.id);
      vi.advanceTimersByTime(6 * 60 * 1000);

      expect(RequestStore.get(record.id)).toBeUndefined();
    });
  });
});
