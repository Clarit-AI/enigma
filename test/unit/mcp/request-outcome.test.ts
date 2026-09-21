import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRequestOutcome } from '../../../src/mcp/request-outcome.js';
import { RequestStore } from '../../../src/request/store.js';
import { setSecret } from '../../../src/storage/manager.js';

describe('resolveRequestOutcome (Issue #62: marks the outcome consumed)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();
  });

  afterEach(() => {
    RequestStore.__resetForTests();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('marks the outcome consumed the moment it resolves, so the record drops out of listUnconsumedFulfilled', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    await setSecret({ name: 'OPENAI_API_KEY', value: 'sentinel-value', scope: 'global', depository: 'encrypted', actor: 'user' });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    expect(RequestStore.listUnconsumedFulfilled()).toHaveLength(1);

    const outcome = await resolveRequestOutcome(record.id, process.cwd());

    expect(outcome.text).toBe('Stored OPENAI_API_KEY in encrypted (global)');
    expect(RequestStore.listUnconsumedFulfilled()).toEqual([]);
  });

  it('a second resolveRequestOutcome call for the same id (a re-await) still returns the correct outcome — idempotent', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    await setSecret({ name: 'OPENAI_API_KEY', value: 'sentinel-value', scope: 'global', depository: 'encrypted', actor: 'user' });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    const first = await resolveRequestOutcome(record.id, process.cwd());
    const second = await resolveRequestOutcome(record.id, process.cwd());

    expect(second).toEqual(first);
    expect(RequestStore.listUnconsumedFulfilled()).toEqual([]);
  });
});
