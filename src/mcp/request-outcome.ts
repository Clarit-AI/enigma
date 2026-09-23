import { EnigmaError } from '../core/errors.js';
import { OutcomeUnknownError, RequestExpiredError, RequestStore } from '../request/store.js';
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
 *
 * Used-record rejection (the human submitted the form but `fulfill` never
 * ran before the used-record grace period elapsed — Issue #69 AC #5) is
 * mapped to `E_OUTCOME_UNKNOWN` here, in one place, so every tool-level
 * caller stays thin. Names only, never a value: the message names the
 * declared names and tells the agent to run `enigma list` to verify.
 * `E_REQUEST_EXPIRED` stays reserved for a record that was never used —
 * typed `RequestExpiredError` (PR #78 batch, Kimi QA AC5), which this
 * mapper also turns into a structured `EnigmaError` right here: the one
 * place every tool-level caller (enigma_await, blocking `enigma_request`,
 * URL-mode `enigma_import`) gets the same code for the same store state, so
 * a blocking request no longer surfaces a never-used expiry as an unhandled
 * tool rejection. Any other rejection is a genuine unexpected error and is
 * rethrown unchanged — never blanket-mapped to a request-specific code.
 */
export async function resolveRequestOutcome(id: string, cwd: string): Promise<Outcome> {
  try {
    await RequestStore.waitForFulfilled(id);
  } catch (err) {
    if (err instanceof OutcomeUnknownError) {
      throw new EnigmaError({
        code: 'E_OUTCOME_UNKNOWN',
        message: `request ${id} was swept before its outcome was recorded; ${err.names.join(', ')} may already be stored — run \`enigma list\` to check before retrying`,
      });
    }
    if (err instanceof RequestExpiredError) {
      throw new EnigmaError({
        code: 'E_REQUEST_EXPIRED',
        message: `request ${id} is unknown or has expired`,
      });
    }
    throw err;
  }
  const results = RequestStore.consumeOutcome(id) ?? [];
  return renderOutcome(results, cwd);
}
