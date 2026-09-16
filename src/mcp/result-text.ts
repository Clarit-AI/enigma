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
 * Renders a batch outcome — failures first (named, with their error code),
 * then successes as "Stored NAME in <depository> (<scope>)" lines — shared
 * by enigma_request's elicitation/fallback/native paths and enigma_await, so
 * the shape and the isError rule never drift between them (Tech Lead ruling,
 * 2026-09-16):
 *   - every name failed: isError:true — nothing was accomplished, the agent
 *     must not proceed as though it has the secrets.
 *   - some succeeded: isError:false — the agent genuinely accomplished part
 *     of the task and must not redo the successful writes; the failures are
 *     led and named so it can retry precisely instead of re-requesting
 *     everything.
 */
export function renderOutcome(results: RequestNameResult[], cwd: string): Outcome {
  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);
  const lines = [
    ...failed.map((r) => `${r.name}: failed (${r.errorCode ?? 'E_UNKNOWN'})`),
    ...renderStoredLines(succeeded.map((r) => r.name), cwd),
  ];
  return { text: lines.join('\n'), isError: succeeded.length === 0 };
}
