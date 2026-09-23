import { describe, expect, it } from 'vitest';
import { renderOutcome } from '../../../src/mcp/result-text.js';
import { annotateSkippedNames } from '../../../src/request/store.js';
import type { RequestNameResult } from '../../../src/request/store.js';

describe('renderOutcome — E_OUTCOME_UNKNOWN (Issue #40)', () => {
  it('renders an unknown outcome differently from a determinate failure for the same name', () => {
    const unknown = renderOutcome([{ name: 'API_KEY', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' }], '/tmp/proj');
    const failed = renderOutcome([{ name: 'API_KEY', ok: false, errorCode: 'E_WRITE_FAILED' }], '/tmp/proj');

    expect(unknown.text).not.toBe(failed.text);
  });

  it('never uses the word "failed" for an unknown outcome', () => {
    const results: RequestNameResult[] = [{ name: 'API_KEY', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' }];
    const outcome = renderOutcome(results, '/tmp/proj');

    expect(outcome.text).not.toMatch(/failed/i);
    expect(outcome.text).toContain('API_KEY: outcome unknown (E_OUTCOME_UNKNOWN)');
  });

  it('still uses "failed" for a determinate failure, unaffected by the unknown case', () => {
    const results: RequestNameResult[] = [{ name: 'API_KEY', ok: false, errorCode: 'E_WRITE_FAILED' }];
    const outcome = renderOutcome(results, '/tmp/proj');

    expect(outcome.text).toBe('API_KEY: failed (E_WRITE_FAILED)');
  });

  it('points at `enigma list` / `enigma doctor`, matching the web page\'s wording, when any name is unknown', () => {
    const results: RequestNameResult[] = [{ name: 'API_KEY', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' }];
    const outcome = renderOutcome(results, '/tmp/proj');

    expect(outcome.text).toContain('Some secrets may already be stored — run `enigma list` or `enigma doctor` to check before retrying.');
  });

  it('does not append the list/doctor guidance line when there is no unknown outcome', () => {
    const results: RequestNameResult[] = [{ name: 'API_KEY', ok: false, errorCode: 'E_WRITE_FAILED' }];
    const outcome = renderOutcome(results, '/tmp/proj');

    expect(outcome.text).not.toContain('enigma list');
  });

  it('is isError:true when every name is unknown, same as when every name is a confirmed failure', () => {
    const allUnknown = renderOutcome(
      [
        { name: 'API_KEY', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' },
        { name: 'DB_URL', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' },
      ],
      '/tmp/proj',
    );

    expect(allUnknown.isError).toBe(true);
  });

  it('lists confirmed failures before unknown outcomes', () => {
    const results: RequestNameResult[] = [
      { name: 'UNKNOWN_NAME', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' },
      { name: 'FAILED_NAME', ok: false, errorCode: 'E_WRITE_FAILED' },
    ];
    const outcome = renderOutcome(results, '/tmp/proj');
    const lines = outcome.text.split('\n');

    expect(lines[0]).toBe('FAILED_NAME: failed (E_WRITE_FAILED)');
    expect(lines[1]).toBe('UNKNOWN_NAME: outcome unknown (E_OUTCOME_UNKNOWN)');
  });
});

describe('renderOutcome — names the human added (Issue #71)', () => {
  it('marks a stored extra "— added by user", and leaves a stored declared name unmarked', () => {
    const outcome = renderOutcome(
      [
        { name: 'DATABASE_URL', ok: true },
        { name: 'DIRECT_URL', ok: true, addedByUser: true },
      ],
      '/tmp/proj',
    );

    const lines = outcome.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Stored DATABASE_URL( in .+)?$/);
    expect(lines[0]).not.toContain('added by user');
    expect(lines[1]).toMatch(/^Stored DIRECT_URL( in .+)? — added by user$/);
    expect(outcome.isError).toBe(false);
  });

  it('marks a failed extra on its failure line (with and without a reason), never a failed declared name', () => {
    const outcome = renderOutcome(
      [
        { name: 'DECLARED', ok: false, errorCode: 'E_EXISTS' },
        { name: 'EXTRA_ONE', ok: false, errorCode: 'E_EXISTS', addedByUser: true },
        { name: 'EXTRA_TWO', ok: false, errorCode: 'E_VALUE_AMBIGUOUS', reason: 'EXTRA_TWO is assigned more than once', addedByUser: true },
      ],
      '/tmp/proj',
    );

    expect(outcome.text.split('\n')).toEqual([
      'DECLARED: failed (E_EXISTS)',
      'EXTRA_ONE: failed (E_EXISTS) — added by user',
      'EXTRA_TWO: failed (E_VALUE_AMBIGUOUS) — EXTRA_TWO is assigned more than once — added by user',
    ]);
    expect(outcome.isError).toBe(true);
  });

  it('appends "N invalid names skipped" (count only) when the batch was annotated, singular for one', () => {
    const many = annotateSkippedNames([{ name: 'A', ok: true }], 2);
    const one = annotateSkippedNames([{ name: 'A', ok: true }], 1);
    const none = annotateSkippedNames([{ name: 'A', ok: true }], 0);

    expect(renderOutcome(many, '/tmp/proj').text.split('\n').at(-1)).toBe('2 invalid names skipped');
    expect(renderOutcome(one, '/tmp/proj').text.split('\n').at(-1)).toBe('1 invalid name skipped');
    expect(renderOutcome(none, '/tmp/proj').text).not.toContain('skipped');
  });

  it('a batch that was never annotated renders exactly as before (no marker, no count line)', () => {
    const outcome = renderOutcome([{ name: 'API_KEY', ok: false, errorCode: 'E_WRITE_FAILED' }], '/tmp/proj');

    expect(outcome.text).toBe('API_KEY: failed (E_WRITE_FAILED)');
  });
});
