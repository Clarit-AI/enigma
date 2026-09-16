import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EnigmaError } from '../core/errors.js';
import type { IndexEntryView } from '../core/index-store.js';
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
