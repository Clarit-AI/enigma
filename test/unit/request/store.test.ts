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

  it('waitForFulfilled resolves to the literal "fulfilled" once tryMarkUsed succeeds', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const waiter = RequestStore.waitForFulfilled(record.id);

    RequestStore.tryMarkUsed(record.id);

    await expect(waiter).resolves.toBe('fulfilled');
  });

  it('waitForFulfilled resolves immediately when the id is already used', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);

    await expect(RequestStore.waitForFulfilled(record.id)).resolves.toBe('fulfilled');
  });

  it('waitForFulfilled rejects for an unknown id', async () => {
    await expect(RequestStore.waitForFulfilled('deadbeefdeadbeefdeadbeefdeadbeef')).rejects.toThrow();
  });

  it('setResults records per-name outcomes, readable via get', () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.setResults(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    expect(RequestStore.get(record.id)?.results).toEqual([{ name: 'OPENAI_API_KEY', ok: true }]);
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
