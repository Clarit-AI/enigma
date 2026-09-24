// enigma:leak-fence-allow: the tripwire is the sanctioned resolve path for scanning tool output (ADR-001, D3.4)
//
// PostToolUse leak tripwire (D3.4, S3.3, ADR-004): scans a tool's output for the
// values of secrets Enigma already holds, and warns — it cannot redact, because
// Claude Code has no output-rewrite hook. On any internal error this fails open
// (exit 0, no output): a crashed tripwire must never block the user's work.
//
// Calls `depository.resolve(ref)` directly from `DEPOSITORY_MODULES` instead of
// going through `storage/manager.ts`'s `resolveSecret`, deliberately: `resolveSecret`
// writes an audit line on every call, and this scans every tracked secret against
// every matching tool call, which would flood the audit log with a `read` line per
// candidate per tool call. Only an actual hit gets audited here, with op `leak`.
import { readIndex } from '../core/index-store.js';
import { loadConfig } from '../core/config.js';
import { appendAuditEvent, auditScopeFields } from '../core/audit.js';
import { findProjectPath, projectId as computeProjectId } from '../core/project.js';
import { DEPOSITORY_MODULES } from '../storage/detect.js';
import type { DepositoryId } from '../storage/interfaces.js';
import type { IndexEntry } from '../core/index-store.js';
import type { PostToolUseInput, PostToolUseOutput } from './types.js';

const MAX_OUTPUT_BYTES = 1_000_000;
const BUDGET_MS = 5000;
/**
 * Values shorter than this are never compared. A short substring (say 4
 * characters) matches far too much incidental text to be trustworthy — the
 * whole point of a tripwire is a signal worth acting on, and a guard that
 * cries wolf gets ignored, same as the read-guard's false-positive concern.
 * This is a heuristic, not a security boundary.
 */
const MIN_SECRET_LENGTH = 6;

/** Depositories the tripwire may ever read from. `encrypted`/`env` are always on;
 * `keychain`/`secret-service` only when explicitly configured; `1password` is
 * never included even if config says so — scanning on every tool call would
 * trigger its `prompts-each-read` prompt profile constantly (D3.4). */
function scanSet(): Set<DepositoryId> {
  const set = new Set<DepositoryId>(['encrypted', 'env']);
  const configured = loadConfig().tripwire?.depositories ?? [];
  for (const id of configured) {
    if (id === 'keychain' || id === 'secret-service') set.add(id);
  }
  return set;
}

/** Mirrors storage/manager.ts's private projectPathFor: the project path a
 * depository instance needs, given where the index entry says it lives. */
function projectPathFor(entry: IndexEntry, cwd: string): string | undefined {
  if (entry.scope === 'project') return entry.projectPath;
  return findProjectPath(cwd);
}

function candidateEntries(cwd: string): IndexEntry[] {
  const scannable = scanSet();
  const pid = computeProjectId(cwd);
  return readIndex().entries.filter(
    (e) => scannable.has(e.depository) && (e.scope === 'global' || e.projectId === pid),
  );
}

function outputText(toolResponse: unknown): string | undefined {
  if (toolResponse === undefined || toolResponse === null) return undefined;
  try {
    return typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
  } catch {
    return undefined;
  }
}

async function scan(input: PostToolUseInput): Promise<PostToolUseOutput | undefined> {
  const text = outputText(input.tool_response);
  if (!text || text.length === 0 || text.length > MAX_OUTPUT_BYTES) return undefined;

  const cwd = input.cwd ?? process.cwd();
  const entries = candidateEntries(cwd);
  if (entries.length === 0) return undefined;

  const deadline = Date.now() + BUDGET_MS;
  const leaked: string[] = [];

  for (const entry of entries) {
    if (Date.now() > deadline) break;

    const mod = DEPOSITORY_MODULES.find((m) => m.id === entry.depository);
    if (!mod) continue;

    // One value at a time: resolved, compared, and discarded before moving to the
    // next candidate, so at most one plaintext secret is ever held here at once —
    // `value` is scoped to this try block alone and never escapes it.
    try {
      const depository = mod.create({ projectPath: projectPathFor(entry, cwd) });
      const value = await depository.resolve(entry.ref);
      if (value.length >= MIN_SECRET_LENGTH && text.includes(value)) {
        leaked.push(entry.name);
        appendAuditEvent({
          op: 'leak',
          name: entry.name,
          depository: entry.depository,
          actor: 'hook',
          ok: true,
          error: null,
          ...auditScopeFields(entry),
        });
      }
    } catch {
      // A resolve failure for one candidate (e.g. a depository that's temporarily
      // unavailable) must not stop the scan of the remaining candidates, nor
      // surface anything — fail open, per-entry.
    }
  }

  if (leaked.length === 0) return undefined;

  const systemMessage = leaked
    .map((name) => `LEAK: value of ${name} appeared in tool output; rotate it via enigma_request rotate:true`)
    .join('\n');
  return { systemMessage };
}

function timeoutAfter(ms: number): Promise<undefined> {
  return new Promise((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout(undefined), ms);
    timer.unref();
  });
}

export async function runTripwire(input: PostToolUseInput): Promise<PostToolUseOutput | undefined> {
  try {
    // Racing a timer bounds how long *this hook process* waits before exiting;
    // `index.ts` calls `process.exit(0)` as soon as this resolves, which ends the
    // process outright even if `scan()` is still awaiting a slow depository call.
    return await Promise.race([scan(input), timeoutAfter(BUDGET_MS)]);
  } catch {
    return undefined;
  }
}
