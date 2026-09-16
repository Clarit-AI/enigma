import { EnigmaError } from './errors.js';
import { auditLogPath } from './paths.js';
import { appendLineSecure } from './secure-file.js';
import type { DepositoryId } from '../storage/interfaces.js';
import type { Scope } from './index-store.js';

export type AuditOp = 'set' | 'rotated' | 'read' | 'reveal' | 'remove' | 'move' | 'import' | 'leak';
export type AuditActor = 'agent' | 'user' | 'cli' | 'hook';

/**
 * One audit line (D1.8). Deliberately has no `value` field: passing one in an
 * object literal is a TypeScript excess-property error, and `error` is never
 * raw error text (see `auditErrorText`) — an accidental value can't ride along.
 */
export interface AuditEvent {
  op: AuditOp;
  name: string;
  scope: Scope;
  depository: DepositoryId;
  actor: AuditActor;
  ok: boolean;
  error: string | null;
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

export function appendAuditEvent(event: AuditEvent): void {
  const line: AuditLine = { ts: new Date().toISOString(), ...event };
  appendLineSecure(auditLogPath(), JSON.stringify(line));
}
