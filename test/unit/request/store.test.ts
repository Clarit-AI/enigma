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

  it('an import may cover more than 10 names (Issue #13: no typing-cost limit applies since values are already known)', () => {
    const names = Array.from({ length: 15 }, (_, i) => `NAME_${i}`);
    const record = RequestStore.create({ kind: 'import', names });
    expect(record.names).toEqual(names);
  });

  it('rejects an import with zero or more than 200 names', () => {
    expect(() => RequestStore.create({ kind: 'import', names: [] })).toThrow();
    expect(() =>
      RequestStore.create({ kind: 'import', names: Array.from({ length: 201 }, (_, i) => `NAME_${i}`) }),
    ).toThrow();
  });

  it('carries values and envFilePath in flight for kind import, readable back via get', () => {
    const record = RequestStore.create({
      kind: 'import',
      names: ['OPENAI_API_KEY'],
      values: { OPENAI_API_KEY: 'sk-abc' },
      envFilePath: '/tmp/project/.env',
    });
    expect(RequestStore.get(record.id)?.values).toEqual({ OPENAI_API_KEY: 'sk-abc' });
    expect(RequestStore.get(record.id)?.envFilePath).toBe('/tmp/project/.env');
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

  describe('consumeOutcome and listUnconsumedFulfilled (Issue #62)', () => {
    it('a fulfilled request/import shows up in listUnconsumedFulfilled before its outcome is ever consumed', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [
        { name: 'OPENAI_API_KEY', ok: true },
        { name: 'GITHUB_TOKEN', ok: true },
      ]);

      const pending = RequestStore.listUnconsumedFulfilled();
      expect(pending).toEqual([
        { id: record.id, stored: ['OPENAI_API_KEY', 'GITHUB_TOKEN'], failed: [], unknown: [] },
      ]);
    });

    it('splits per-name outcomes into `stored`, `failed`, and `unknown` — mirrors `renderOutcome`\'s bucketing so the recovery signal can label each without exposing error text (ADR-001)', () => {
      const record = RequestStore.create({
        kind: 'request',
        names: ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'STRIPE_KEY'],
      });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [
        { name: 'OPENAI_API_KEY', ok: true },
        { name: 'GITHUB_TOKEN', ok: false, errorCode: 'E_VALUE_AMBIGUOUS', reason: 'flagged at parse time' },
        { name: 'STRIPE_KEY', ok: true },
      ]);

      const [entry] = RequestStore.listUnconsumedFulfilled();
      expect(entry).toEqual({
        id: record.id,
        stored: ['OPENAI_API_KEY', 'STRIPE_KEY'],
        failed: ['GITHUB_TOKEN'],
        unknown: [],
      });
      expect(Object.keys(entry!).sort()).toEqual(['failed', 'id', 'stored', 'unknown']);
    });

    it('routes E_OUTCOME_UNKNOWN to the `unknown` bucket, NOT to `failed` (Issue #40 — an unknown outcome is not a confirmed failure)', () => {
      const record = RequestStore.create({
        kind: 'request',
        names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'],
      });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [
        { name: 'OPENAI_API_KEY', ok: true },
        { name: 'GITHUB_TOKEN', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' },
      ]);

      const [entry] = RequestStore.listUnconsumedFulfilled();
      expect(entry?.unknown).toEqual(['GITHUB_TOKEN']);
      expect(entry?.failed).toEqual([]);
      expect(entry?.stored).toEqual(['OPENAI_API_KEY']);
    });

    it('renders all three buckets correctly when one record mixes stored, failed, and unknown', () => {
      const record = RequestStore.create({
        kind: 'request',
        names: ['A_OK', 'B_FAIL', 'C_UNKNOWN', 'D_OK'],
      });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [
        { name: 'A_OK', ok: true },
        { name: 'B_FAIL', ok: false, errorCode: 'E_VALUE_AMBIGUOUS', reason: 'static-text-only' },
        { name: 'C_UNKNOWN', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' },
        { name: 'D_OK', ok: true },
      ]);

      const [entry] = RequestStore.listUnconsumedFulfilled();
      expect(entry?.stored).toEqual(['A_OK', 'D_OK']);
      expect(entry?.failed).toEqual(['B_FAIL']);
      expect(entry?.unknown).toEqual(['C_UNKNOWN']);
    });

    it('a record whose `results` is empty (the default for `fulfill(id)`) does NOT appear — there are no names to re-await', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id); // defaults to results: []

      expect(RequestStore.listUnconsumedFulfilled()).toEqual([]);
      expect(RequestStore.get(record.id)?.results).toEqual([]); // record still exists, just not surfaced
      void record;
    });

    it('reading listUnconsumedFulfilled repeatedly does not itself mark anything consumed (the signal cannot erase itself)', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

      RequestStore.listUnconsumedFulfilled();
      RequestStore.listUnconsumedFulfilled();
      RequestStore.listUnconsumedFulfilled();

      expect(RequestStore.listUnconsumedFulfilled()).toHaveLength(1);
      expect(RequestStore.get(record.id)?.outcomeConsumedAt).toBeUndefined();
    });

    it('once consumeOutcome has read a record, it no longer appears in listUnconsumedFulfilled', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

      expect(RequestStore.listUnconsumedFulfilled()).toHaveLength(1);

      const results = RequestStore.consumeOutcome(record.id);

      expect(results).toEqual([{ name: 'OPENAI_API_KEY', ok: true }]);
      expect(RequestStore.listUnconsumedFulfilled()).toEqual([]);
      expect(RequestStore.get(record.id)?.outcomeConsumedAt).toBeTypeOf('number');
    });

    it('consumeOutcome is idempotent: a second call (a re-await) still returns the same results and does not reset outcomeConsumedAt', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

      const first = RequestStore.consumeOutcome(record.id);
      const firstConsumedAt = RequestStore.get(record.id)?.outcomeConsumedAt;
      const second = RequestStore.consumeOutcome(record.id);

      expect(second).toEqual(first);
      expect(RequestStore.get(record.id)?.outcomeConsumedAt).toBe(firstConsumedAt);
    });

    it('consumeOutcome returns undefined for an unknown id or a record not yet fulfilled', () => {
      expect(RequestStore.consumeOutcome('deadbeefdeadbeefdeadbeefdeadbeef')).toBeUndefined();

      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      expect(RequestStore.consumeOutcome(record.id)).toBeUndefined();
    });

    it('a fulfilled reveal never appears in listUnconsumedFulfilled — enigma_reveal never blocks on resolveRequestOutcome', () => {
      const reveal = RequestStore.create({ kind: 'reveal', names: ['GITHUB_TOKEN'] });
      RequestStore.tryMarkUsed(reveal.id);
      RequestStore.fulfill(reveal.id);

      expect(RequestStore.listUnconsumedFulfilled()).toEqual([]);
    });

    it('a fulfilled import shows up too, since enigma_import also reads through resolveRequestOutcome', () => {
      const record = RequestStore.create({ kind: 'import', names: ['OPENAI_API_KEY'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

      expect(RequestStore.listUnconsumedFulfilled()).toEqual([
        { id: record.id, stored: ['OPENAI_API_KEY'], failed: [], unknown: [] },
      ]);
    });

    it('a record that is not yet fulfilled (no results) does not appear', () => {
      RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
      expect(RequestStore.listUnconsumedFulfilled()).toEqual([]);
    });

    // Forward contract for Issue #71 (extensible request form). The two
    // tests below pin behaviors that today's POST loop in src/web/routes/
    // does NOT exercise — every code path there emits one result per
    // declared name, so a "subset" results shape or a name added at
    // submit time can't happen yet. They exist to lock the store-layer
    // contract before #71 lands, so the recovery signal stays correct
    // when the POST loop is changed.
    it('[forward #71] includes names added by the human at submit time — names in `results` not in `record.names` must appear in the signal', () => {
      const record = RequestStore.create({ kind: 'request', names: ['A'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [
        { name: 'A', ok: true },
        { name: 'HUMAN_ADDED', ok: true },
      ]);

      const [entry] = RequestStore.listUnconsumedFulfilled();
      expect(entry?.stored).toEqual(['A', 'HUMAN_ADDED']);
    });

    it('[forward #71] preserves the results ordering within each bucket — the recovery signal must match the per-name order `results` carries', () => {
      const record = RequestStore.create({ kind: 'request', names: ['A', 'B', 'C'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [
        { name: 'C', ok: true },
        { name: 'A', ok: true },
        { name: 'B', ok: true },
      ]);

      const [entry] = RequestStore.listUnconsumedFulfilled();
      expect(entry?.stored).toEqual(['C', 'A', 'B']);
    });

    it('an expired/swept record is gone from the store entirely, so it cannot appear as unconsumed-fulfilled', () => {
      vi.useFakeTimers();
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: 1000 });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);
      expect(RequestStore.listUnconsumedFulfilled()).toHaveLength(1);

      // Past the used-record grace period the sweeper deletes it outright.
      vi.advanceTimersByTime(6 * 60 * 1000);

      expect(RequestStore.listUnconsumedFulfilled()).toEqual([]);
    });
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
