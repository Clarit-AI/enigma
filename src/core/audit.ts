import { EnigmaError } from './errors.js';
import { auditLogPath } from './paths.js';
import { appendLineSecure } from './secure-file.js';
import type { DepositoryId } from '../storage/interfaces.js';
import type { Scope } from './index-store.js';

export type AuditOp = 'set' | 'rotated' | 'read' | 'reveal' | 'remove' | 'move' | 'import' | 'migrate' | 'leak';
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
 *
 * `projectId`/`projectPath` (Issue #80) attribute the line to a project: the
 * log is one per-user file shared by every repo, so a project-scoped line
 * names which project it came from — the repo-identity id (`projectId(cwd)`,
 * Issue #67, the same id the index uses, not a lexical path hash) plus the
 * worktree path in clear, exactly as the index already records it (D1.1).
 * Present iff `scope === 'project'` — a global line carries neither. Lines
 * written before Issue #80 simply omit both; treat an absent `projectId` as
 * "not recorded", never as a specific project. Enforced at write time by
 * `AuditEventInput`/`auditScopeFields`, not by this field's optionality.
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
  projectId?: string;
  projectPath?: string;
}

interface AuditLine extends AuditEvent {
  ts: string;
}

/**
 * The scope-paired slice of an audit line (Issue #80). A project line MUST
 * carry `projectId` — the discriminated union makes a forgotten id a
 * compile error at the call site, not a silently unattributed log line.
 * `projectPath` rides along when known (it is optional because an index
 * entry can legitimately lack a recorded path). A global line carries
 * neither field — passing `projectId` on a `scope: 'global'` literal is an
 * excess-property error.
 */
export type AuditScopeFields =
  // `?: never` on the global member matters: TypeScript distributes a
  // union-typed discriminant over the union members, so without it a call
  // site passing `{ scope: <Scope>, projectId: <id> }` would type-check and
  // could write a projectId onto a global line.
  | { scope: 'global'; projectId?: never; projectPath?: never }
  | { scope: 'project'; projectId: string; projectPath?: string };

/**
 * What `appendAuditEvent` accepts: the event fields plus the discriminated
 * scope slice. Keeping `AuditEvent` itself wide preserves read-side
 * compatibility — old log lines without the project fields still satisfy
 * the type — while writes go through this narrowed shape.
 */
export type AuditEventInput = Omit<AuditEvent, 'scope' | 'projectId' | 'projectPath'> & AuditScopeFields;

/**
 * Narrows a scope-bearing source — an index entry, or a synthesized
 * `{ scope, projectId, projectPath }` — to the slice `appendAuditEvent`
 * requires. Every call site whose scope is a runtime `Scope` (i.e. all of
 * them) goes through here, so the project/global pairing can never drift
 * apart at a call site. Throws `E_INDEX_CORRUPT` when the source claims
 * project scope but carries no `projectId`: an index entry in that state
 * is corrupt, and writing the line unattributed would silently reproduce
 * the exact gap Issue #80 closes.
 */
export function auditScopeFields(source: {
  scope: Scope;
  projectId?: string;
  projectPath?: string;
}): AuditScopeFields {
  if (source.scope !== 'project') return { scope: 'global' };
  if (source.projectId === undefined) {
    throw new EnigmaError({
      code: 'E_INDEX_CORRUPT',
      message: 'project-scoped audit source has no projectId',
    });
  }
  return { scope: 'project', projectId: source.projectId, projectPath: source.projectPath };
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

export function appendAuditEvent(event: AuditEventInput): void {
  const line: AuditLine = { ts: new Date().toISOString(), ...event };
  appendLineSecure(auditLogPath(), JSON.stringify(line));
}
