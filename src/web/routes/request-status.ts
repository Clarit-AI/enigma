import type { ServerResponse } from 'node:http';
import { RequestStore } from '../../request/store.js';
import { sendErrorPage, sendJson } from '../responses.js';

/**
 * GET /r/<id>/status — a cheap state-only poll for host background-watch
 * tools (Claude Code's `Monitor`, etc.) to wake a turn when the human
 * submits the request form, without rendering the full form (Issue #69 §1).
 *
 * Deliberately answers ONLY for `kind === 'request'`: an `import` or
 * `reveal` id at this path returns 404, so the route never confirms that
 * other kinds of record exist (the id space is shared but the surface is
 * not — `GET /v/<id>/status` and `GET /i/<id>/status` are different shapes
 * and would need their own routes to be honest). Names are never read,
 * values are never touched, and `consumeOutcome` is never called — calling
 * this endpoint does not move a record out of `listUnconsumedFulfilled`,
 * so a Monitor that polls it cannot make the recovery signal disappear on
 * its own (AC #3). Security headers (CSP, `Cache-Control: no-store`, …)
 * are applied by `router.ts` before dispatch, identical to every other
 * route.
 */
export function handleRequestStatusGet(res: ServerResponse, id: string): void {
  const record = RequestStore.get(id);
  if (!record || record.kind !== 'request') {
    sendErrorPage(res, 404, 'Not found', 'This link is unknown or has expired.');
    return;
  }
  const state = record.results !== undefined ? 'fulfilled' : 'pending';
  sendJson(res, 200, { state });
}