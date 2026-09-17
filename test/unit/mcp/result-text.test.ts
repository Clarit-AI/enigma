import { describe, expect, it } from 'vitest';
import { renderOutcome } from '../../../src/mcp/result-text.js';
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
