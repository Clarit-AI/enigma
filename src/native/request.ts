import type { AuditActor } from '../core/audit.js';
import { loadConfig } from '../core/config.js';
import { EnigmaError } from '../core/errors.js';
import type { Scope } from '../core/index-store.js';
import { setSecret } from '../storage/manager.js';
import type { DepositoryId } from '../storage/interfaces.js';
import { buildHiddenAnswerScript } from './apple-script.js';
import type { DialogProgress } from './apple-script.js';
import { execWithStdin } from './exec.js';
import { assertDarwin } from './platform.js';

const DIALOG_TIMEOUT_MS = 10 * 60 * 1000; // generous: a human may take a while to find/enter a value
const DIALOG_MAX_BUFFER_BYTES = 64 * 1024;
/** AppleScript's standard error number for `display dialog`'s Cancel button. */
const CANCEL_MARKER = '-128';

export interface NativeRequestOptions {
  names: string[];
  reason: string;
  /** @default 'project' */
  scope?: Scope;
  /** @default the configured default depository, falling back to 'encrypted' (mirrors `enigma add`). */
  depository?: DepositoryId;
  cwd?: string;
  description?: string;
  usage?: 'interactive' | 'unattended';
  rotate?: boolean;
  /** @default 'user' — the human answering the dialog, not the calling agent/tool. */
  actor?: AuditActor;
  /** Explicit, one-time user confirmation to create a depository's backing collection when missing (Issue #28); forwarded to `setSecret`. Never a default. */
  createVault?: boolean;
  /**
   * For a retry that continues a longer request (the vault-confirmation retry
   * passes the not-yet-stored tail of `names`): how many names were already
   * handled and how many there are in all, so the dialogs keep saying "3 of 3"
   * rather than restarting at "1 of 1". Defaults to `names` alone.
   */
  progress?: { offset: number; total: number };
}

/** Names only; a value never leaves this module except through `setSecret` (ADR-001). */
export interface NativeRequestResult {
  stored: string[];
}

async function promptHiddenAnswer(name: string, reason: string, progress: DialogProgress): Promise<string> {
  const script = buildHiddenAnswerScript(name, reason, progress);
  const { code, stdout, stderr } = await execWithStdin('osascript', ['-'], script, {
    timeoutMs: DIALOG_TIMEOUT_MS,
    maxBufferBytes: DIALOG_MAX_BUFFER_BYTES,
  });

  if (code === 0) {
    return stdout.replace(/\r?\n$/, '');
  }
  if (stderr.includes(CANCEL_MARKER)) {
    throw new EnigmaError({ code: 'E_REQUEST_CANCELLED', message: `request cancelled for ${name}`, secretName: name });
  }
  throw new EnigmaError({ code: 'E_UI_UNAVAILABLE', message: `osascript dialog failed for ${name}`, secretName: name });
}

/**
 * One hidden-answer `osascript` dialog per name (PRD D2.5); each value is
 * written straight through `setSecret` and never returned from this function.
 */
export async function nativeRequest(opts: NativeRequestOptions): Promise<NativeRequestResult> {
  assertDarwin();

  const cwd = opts.cwd ?? process.cwd();
  const scope: Scope = opts.scope ?? 'project';
  const depository: DepositoryId = opts.depository ?? loadConfig().defaultDepository ?? 'encrypted';
  const actor: AuditActor = opts.actor ?? 'user';

  const offset = opts.progress?.offset ?? 0;
  const total = opts.progress?.total ?? opts.names.length;
  const stored: string[] = [];
  for (const [i, name] of opts.names.entries()) {
    const value = await promptHiddenAnswer(name, opts.reason, { index: offset + i + 1, total });
    await setSecret({
      name,
      value,
      scope,
      depository,
      cwd,
      description: opts.description,
      usage: opts.usage,
      rotate: opts.rotate,
      actor,
      createVault: opts.createVault,
    });
    stored.push(name);
  }
  return { stored };
}
