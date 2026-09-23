import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRequestOutcome } from '../../../src/mcp/request-outcome.js';
import { RequestStore, annotateSkippedNames, getSkippedNameCount } from '../../../src/request/store.js';
import { setSecret } from '../../../src/storage/manager.js';

// Issue #71: the skipped-name count rides beside the `results` array (a
// WeakMap keyed on it), not inside a RequestNameResult. That only works while
// every hop between the web POST handler and renderOutcome hands on the SAME
// array. These tests pin each hop, so a future change that copies the array
// (e.g. `record.results = [...results]`) fails here instead of silently
// dropping the "N invalid names skipped" line.
describe('skipped-name count lifecycle (Issue #71)', () => {
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

  it('survives fulfill → waitForFulfilled → consumeOutcome as the same array, and a waiter attached before fulfil sees it too', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const waiting = RequestStore.waitForFulfilled(record.id);
    RequestStore.tryMarkUsed(record.id);

    RequestStore.fulfill(record.id, annotateSkippedNames([{ name: 'OPENAI_API_KEY', ok: true }], 3));
    await waiting;

    const consumed = RequestStore.consumeOutcome(record.id)!;
    expect(getSkippedNameCount(consumed)).toBe(3);
    expect(RequestStore.get(record.id)?.results).toBe(consumed);
    // Idempotent re-read (a second enigma_await) still carries it.
    expect(getSkippedNameCount(RequestStore.consumeOutcome(record.id)!)).toBe(3);
  });

  it('reaches the rendered outcome through resolveRequestOutcome, the path both enigma_request and enigma_await use, on first and repeat reads', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'user' });
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, annotateSkippedNames([{ name: 'OPENAI_API_KEY', ok: true }], 2));

    const first = await resolveRequestOutcome(record.id, process.cwd());
    const second = await resolveRequestOutcome(record.id, process.cwd());

    expect(first.text.split('\n').at(-1)).toBe('2 invalid names skipped');
    expect(second).toEqual(first);
  });

  it('a copy of the array does not inherit the count (the dependency this file guards)', () => {
    const results = annotateSkippedNames([{ name: 'A', ok: true }], 1);

    expect(getSkippedNameCount(results)).toBe(1);
    expect(getSkippedNameCount([...results])).toBe(0);
  });

  it('a zero count is not recorded, and an unannotated batch reads as 0', () => {
    expect(getSkippedNameCount(annotateSkippedNames([{ name: 'A', ok: true }], 0))).toBe(0);
    expect(getSkippedNameCount([])).toBe(0);
  });
});
