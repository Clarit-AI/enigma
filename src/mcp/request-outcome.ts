import { RequestStore } from '../request/store.js';
import type { RequestNameResult } from '../request/store.js';
import { renderStoredLine } from './result-text.js';

const RESULTS_POLL_INTERVAL_MS = 10;
const RESULTS_POLL_TIMEOUT_MS = 5000;

/**
 * `RequestStore.tryMarkUsed` resolves the fulfilment waiter before the web
 * route finishes writing every name and calling `setResults`
 * (src/web/routes/request-form.ts: tryMarkUsed happens first, the per-name
 * setSecret loop and setResults happen after) — the waiter and the results
 * array settle at two different points within the same POST handler. A short
 * poll after the waiter resolves closes that window without changing the
 * store's contract.
 */
async function waitForResults(id: string): Promise<RequestNameResult[]> {
  await RequestStore.waitForFulfilled(id);
  const deadline = Date.now() + RESULTS_POLL_TIMEOUT_MS;
  for (;;) {
    const record = RequestStore.get(id);
    if (record?.results) return record.results;
    if (Date.now() >= deadline) {
      throw new Error(`request ${id} was fulfilled but its results never settled`);
    }
    await new Promise((resolve) => setTimeout(resolve, RESULTS_POLL_INTERVAL_MS));
  }
}

/** Blocks until a request/reveal id is fulfilled, then renders its per-name outcome (used by enigma_request and enigma_await). */
export async function resolveRequestOutcome(id: string, cwd: string): Promise<string> {
  const results = await waitForResults(id);
  return results
    .map((r) => (r.ok ? renderStoredLine(r.name, cwd) : `${r.name}: failed (${r.errorCode ?? 'E_UNKNOWN'})`))
    .join('\n');
}
