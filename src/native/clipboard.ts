import type { AuditActor } from '../core/audit.js';
import { appendAuditEvent, auditErrorText } from '../core/audit.js';
import { EnigmaError } from '../core/errors.js';
import { readIndex, resolveIndexEntry } from '../core/index-store.js';
import type { Scope } from '../core/index-store.js';
import { projectId as computeProjectId } from '../core/project.js';
import { resolveSecret } from '../storage/manager.js';
import { execWithStdin } from './exec.js';
import { assertDarwin } from './platform.js';

const CLIPBOARD_TIMEOUT_MS = 5000;
const CLIPBOARD_MAX_BUFFER_BYTES = 64 * 1024;
const CLEAR_DELAY_MS = 60_000;

export interface ClipboardRevealOptions {
  scope?: Scope;
  cwd?: string;
  /** @default 'user' */
  actor?: AuditActor;
}

async function writeClipboard(value: string): Promise<void> {
  await execWithStdin('pbcopy', [], value, {
    timeoutMs: CLIPBOARD_TIMEOUT_MS,
    maxBufferBytes: CLIPBOARD_MAX_BUFFER_BYTES,
  });
}

async function readClipboard(): Promise<string> {
  const { stdout } = await execWithStdin('pbpaste', [], '', {
    timeoutMs: CLIPBOARD_TIMEOUT_MS,
    maxBufferBytes: CLIPBOARD_MAX_BUFFER_BYTES,
  });
  return stdout;
}

/**
 * Clears the clipboard 60s after a reveal, but only if it still holds the
 * revealed value — if the user copied something else meanwhile, it is left
 * alone. Fire-and-forget: never rejects, never surfaces the value. `unref`ed
 * so a short-lived caller (e.g. a CLI command) can exit right after printing
 * the status string instead of the event loop staying alive for 60s.
 */
function scheduleClear(value: string): void {
  const timer = setTimeout(() => {
    readClipboard()
      .then((current) => (current === value ? writeClipboard('') : undefined))
      .catch(() => {
        // best-effort clear; a failure here must never surface the value
      });
  }, CLEAR_DELAY_MS);
  timer.unref();
}

/**
 * Resolves `name` and copies it to the clipboard via `pbcopy` on stdin (PRD
 * D2.5). Returns only a status string — the value never leaves this module
 * except onto the OS clipboard itself.
 */
export async function clipboardReveal(name: string, opts: ClipboardRevealOptions = {}): Promise<string> {
  assertDarwin();

  const cwd = opts.cwd ?? process.cwd();
  const actor: AuditActor = opts.actor ?? 'user';
  const pid = computeProjectId(cwd);
  const entry = resolveIndexEntry(readIndex(), name, opts.scope, pid);
  if (!entry) {
    throw new EnigmaError({ code: 'E_NOT_FOUND', message: `${name} not found`, secretName: name });
  }

  const value = await resolveSecret(name, { scope: entry.scope, cwd, actor, auditOp: 'reveal', auditMethod: 'clipboard' });

  try {
    await writeClipboard(value);
  } catch (err) {
    // resolveSecret already audited the successful reveal; a pbcopy failure
    // after that is a distinct, unaudited failure mode and needs its own line.
    appendAuditEvent({
      op: 'reveal',
      name,
      scope: entry.scope,
      depository: entry.depository,
      actor,
      ok: false,
      error: auditErrorText(err),
      method: 'clipboard',
    });
    throw err;
  }

  scheduleClear(value);
  return 'Copied to clipboard; clears in 60 s';
}
