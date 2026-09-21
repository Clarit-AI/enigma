import { RequestStore } from '../request/store.js';
import { renderOutcome } from './result-text.js';
import type { Outcome } from './result-text.js';

/**
 * Blocks until a request/reveal id is fulfilled, then renders its per-name
 * outcome (used by enigma_request, enigma_await, and enigma_import).
 * `RequestStore.fulfill` records `results` before it resolves the waiter, so
 * `consumeOutcome(id)` is guaranteed to find them readable the moment this
 * resolves — no polling needed. Reading through `consumeOutcome` (rather
 * than `get(id)?.results`) is what marks the outcome as seen by the agent
 * (Issue #62) — the single point every caller that returns outcome text to
 * the model passes through, so `RequestStore.listUnconsumedFulfilled` stops
 * listing this id from here on.
 */
export async function resolveRequestOutcome(id: string, cwd: string): Promise<Outcome> {
  await RequestStore.waitForFulfilled(id);
  const results = RequestStore.consumeOutcome(id) ?? [];
  return renderOutcome(results, cwd);
}
