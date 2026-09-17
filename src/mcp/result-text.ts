import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EnigmaError } from '../core/errors.js';
import type { IndexEntryView } from '../core/index-store.js';
import type { RequestNameResult } from '../request/store.js';
import { listSecrets } from '../storage/manager.js';

export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/** `E_CODE: message`, no values (docs/api-contracts.md §1 error shape). */
export function errorResult(err: unknown): CallToolResult {
  if (err instanceof EnigmaError) {
    return textResult(`${err.code}: ${err.message}`, true);
  }
  return textResult('E_UNKNOWN: an unexpected error occurred', true);
}

/**
 * Looks up the depository and scope a just-written name actually landed in.
 * The request-form and native flows let the human (or a default) choose
 * these after the tool call started, so the index is the only accurate
 * source — never the tool's own input, which may not match what happened.
 */
function findJustWrittenEntry(name: string, cwd: string): IndexEntryView | undefined {
  const entries = listSecrets({ scope: 'all', cwd }).filter((e) => e.name === name);
  if (entries.length <= 1) return entries[0];
  return entries.reduce((latest, entry) => (entry.updatedAt > latest.updatedAt ? entry : latest));
}

/**
 * "Stored NAME in <depository> (<scope>)" (docs/api-contracts.md §1) — shared
 * by every path that can store a secret (URL-mode elicitation, the
 * enigma_await fallback, and the native ui:"native" path) so the wording
 * never drifts between them.
 */
export function renderStoredLine(name: string, cwd: string): string {
  const entry = findJustWrittenEntry(name, cwd);
  return entry ? `Stored ${name} in ${entry.depository} (${entry.scope})` : `Stored ${name}`;
}

export function renderStoredLines(names: string[], cwd: string): string[] {
  return names.map((name) => renderStoredLine(name, cwd));
}

export interface Outcome {
  text: string;
  isError: boolean;
}

/**
 * Renders a batch outcome — confirmed failures first (named, with their
 * error code and, when present, `reason` — the one narrow exception to
 * "never a message", see RequestNameResult's doc comment), then names whose
 * outcome is unknown (`E_OUTCOME_UNKNOWN` — commitImport crashed after its
 * internal storage loop, so these may genuinely be stored; see that error
 * code's origin in src/web/routes/import-form.ts), then successes as
 * "Stored NAME in <depository> (<scope>)" lines — shared by enigma_request's
 * elicitation/fallback/native paths, enigma_await, and enigma_import's
 * direct-depository/elicitation/fallback paths, so the shape and the
 * isError rule never drift between them (Tech Lead ruling, 2026-09-16,
 * Issue #40):
 *   - every name confirmed failed, none unknown, none succeeded: isError:true
 *     — nothing was accomplished, the agent must not proceed as though it
 *     has the secrets.
 *   - some succeeded: isError:false — the agent genuinely accomplished part
 *     of the task and must not redo the successful writes; the failures are
 *     led and named so it can retry precisely instead of re-requesting
 *     everything.
 *   - some (or all) unknown, none succeeded: isError:true. An unknown
 *     outcome is not a confirmed failure — the word "failed" is never used
 *     for it, and the per-name line says so — but it is also not a confirmed
 *     success, and isError is the one signal a caller cannot afford to read
 *     as a hedge: it is a boolean, so it must land on the side that makes no
 *     false claim of accomplishment. This also keeps the MCP result honest
 *     against the web page's own hedge, which renders the same event as an
 *     HTTP 500 ("Import failed", body qualified) rather than a 200 — the
 *     severity signal agrees between the human and the agent even though
 *     the wording no longer does.
 */
export function renderOutcome(results: RequestNameResult[], cwd: string): Outcome {
  const failed = results.filter((r) => !r.ok && r.errorCode !== 'E_OUTCOME_UNKNOWN');
  const unknown = results.filter((r) => !r.ok && r.errorCode === 'E_OUTCOME_UNKNOWN');
  const succeeded = results.filter((r) => r.ok);
  const lines = [
    ...failed.map((r) => (r.reason ? `${r.name}: failed (${r.errorCode ?? 'E_UNKNOWN'}) — ${r.reason}` : `${r.name}: failed (${r.errorCode ?? 'E_UNKNOWN'})`)),
    ...unknown.map((r) => `${r.name}: outcome unknown (E_OUTCOME_UNKNOWN)`),
    ...renderStoredLines(succeeded.map((r) => r.name), cwd),
  ];
  if (unknown.length > 0) {
    lines.push('Some secrets may already be stored — run `enigma list` or `enigma doctor` to check before retrying.');
  }
  return { text: lines.join('\n'), isError: succeeded.length === 0 };
}
