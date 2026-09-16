import { RequestStore } from '../request/store.js';
import { renderOutcome } from './result-text.js';
import type { Outcome } from './result-text.js';

/**
 * Blocks until a request/reveal id is fulfilled, then renders its per-name
 * outcome (used by enigma_request and enigma_await). `RequestStore.fulfill`
 * records `results` before it resolves the waiter, so `get(id)?.results` is
 * guaranteed readable the moment this resolves — no polling needed.
 */
export async function resolveRequestOutcome(id: string, cwd: string): Promise<Outcome> {
  await RequestStore.waitForFulfilled(id);
  const results = RequestStore.get(id)?.results ?? [];
  return renderOutcome(results, cwd);
}
