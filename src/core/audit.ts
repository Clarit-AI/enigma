import { EnigmaError } from './errors.js';
import { auditLogPath } from './paths.js';
import { appendLineSecure } from './secure-file.js';
import type { DepositoryId } from '../storage/interfaces.js';
import type { Scope } from './index-store.js';

export type AuditOp = 'set' | 'rotated' | 'read' | 'reveal' | 'remove' | 'move' | 'import' | 'leak';
export type AuditActor = 'agent' | 'user' | 'cli' | 'hook';

/**
 * How a secret was disclosed to a human — distinct disclosure surfaces with
 * different exposure (Issue #26): `clipboard` never leaves this machine;
 * `page` renders in a browser that may be reachable over a remote tunnel
 * (PRD D2.6). A union, not a free string, so a typo can't silently create a
 * new, unaudited category — which also means a member is only ever added
 * alongside the reveal path that actually produces it (there is no third
 * reveal surface today: `enigma_reveal`'s own method is `page | clipboard`).
 */
export type AuditRevealMethod = 'clipboard' | 'page';

/**
 * One audit line (D1.8). Deliberately has no `value` field: passing one in an
 * object literal is a TypeScript excess-property error, and `error` is never
 * raw error text (see `auditErrorText`) — an accidental value can't ride along.
 *
 * `method` is optional and set only for a `reveal` op — it can never carry a
 * value, a ref, or anything derived from the secret, only the name of the
 * disclosure surface itself. A line written before Issue #26 (or any other
 * op) simply omits it; treat an absent `method` as "not recorded", never as
 * a specific method.
 */
export interface AuditEvent {
  op: AuditOp;
  name: string;
  scope: Scope;
  depository: DepositoryId;
  actor: AuditActor;
  ok: boolean;
  error: string | null;
  method?: AuditRevealMethod;
}

interface AuditLine extends AuditEvent {
  ts: string;
}

/**
 * Maps an error to safe audit text: an `EnigmaError` becomes `"CODE: message"`
 * (both are name-only by convention); anything else becomes only its
 * constructor name, since an arbitrary error's `.message` could echo a value
 * surfaced by a lower layer.
 */
export function auditErrorText(err: unknown): string {
  if (err instanceof EnigmaError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.constructor.name;
  return 'UnknownError';
}

/**
 * Classify a best-effort old-location delete error into a value-free reason
 * label (Issue #22, AC #5). The label names the failure mode (e.g.
 * `permission-denied`) but never the value or any text the depository might
 * have echoed. Falls back to `auditErrorText` — which by contract returns
 * either `CODE: message` for an EnigmaError or the constructor name for
 * anything else — so we never surface a free-form error string that could
 * carry value-derived text. Shared by `move`'s old-depository cleanup and
 * `setSecret`'s same-depository rotate cleanup (Issue #70).
 */
export function classifyCleanupError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'ref-not-found';
  if (code === 'EACCES' || code === 'EPERM') return 'permission-denied';
  if (code === 'ENOTDIR' || code === 'EISDIR') return 'path-invalid';
  if (code === 'EBUSY') return 'resource-busy';
  return auditErrorText(err);
}

export function appendAuditEvent(event: AuditEvent): void {
  const line: AuditLine = { ts: new Date().toISOString(), ...event };
  appendLineSecure(auditLogPath(), JSON.stringify(line));
}
