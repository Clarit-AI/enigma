// enigma:leak-fence-allow: storage manager is the sanctioned resolve path (ADR-001)
//
// Orchestrates naming validation, the index, audit logging, and depository
// dispatch. A secret value only ever passes through this file and
// src/storage/depositories/** (style-guide secret-handling conventions).

import { EnigmaError } from '../core/errors.js';
import { validateName } from '../core/naming.js';
import { findProjectPath, projectId as computeProjectId } from '../core/project.js';
import { appendAuditEvent, auditErrorText } from '../core/audit.js';
import type { AuditActor, AuditEvent } from '../core/audit.js';
import {
  buildRef,
  findIndexEntry,
  listIndexEntries,
  readIndex,
  removeIndexEntry,
  resolveIndexEntry,
  upsertIndexEntry,
  writeIndex,
} from '../core/index-store.js';
import type { IndexEntry, IndexEntryView, Scope } from '../core/index-store.js';
import { DEPOSITORY_MODULES } from './detect.js';
import { checkEnvGitignore } from './depositories/env.js';
import type { Depository, DepositoryContext, DepositoryId } from './interfaces.js';

function getDepositoryModule(id: DepositoryId) {
  const mod = DEPOSITORY_MODULES.find((m) => m.id === id);
  if (!mod) {
    throw new EnigmaError({
      code: 'E_DEPOSITORY_UNAVAILABLE',
      message: `depository not available: ${id}`,
      depository: id,
    });
  }
  return mod;
}

function createDepository(id: DepositoryId, ctx: DepositoryContext = {}): Depository {
  return getDepositoryModule(id).create(ctx);
}

/** The project path a depository instance needs, given where an index entry says it lives. */
function projectPathFor(entry: Pick<IndexEntry, 'scope' | 'projectPath'>, cwd?: string): string | undefined {
  if (entry.scope === 'project') return entry.projectPath;
  return cwd ? findProjectPath(cwd) : undefined;
}

export interface SetSecretOptions {
  name: string;
  value: string;
  scope: Scope;
  depository: DepositoryId;
  /** Required for scope 'project' and for the 'env' depository (any scope). */
  cwd?: string;
  description?: string;
  usage?: 'interactive' | 'unattended';
  rotate?: boolean;
  actor: AuditActor;
  /** Explicit, one-time user confirmation to create a depository's backing collection when missing (consumed only by `1password`; never a default). */
  createVault?: boolean;
  /** Overrides the default audit op ('set'/'rotated'); mirrors resolveSecret's auditOp (Issue #7). `enigma import` passes 'import'. */
  auditOp?: AuditEvent['op'];
}

export interface SetSecretResult {
  rotated: boolean;
  warnings: string[];
}

export async function setSecret(opts: SetSecretOptions): Promise<SetSecretResult> {
  // Every refusal below — not just a depository write failure — is audited with the same
  // shape: a refusal is an operation that happened and left the world unchanged, and a
  // reader of the audit log deserves to see it (Issue #39's reasoning, applied to every
  // throw site setSecret itself owns, not only the one `commitImport` originally surfaced).
  const auditRefusal = (err: unknown, op: AuditEvent['op']): void => {
    appendAuditEvent({ op, name: opts.name, scope: opts.scope, depository: opts.depository, actor: opts.actor, ok: false, error: auditErrorText(err) });
  };

  try {
    validateName(opts.name);
  } catch (err) {
    auditRefusal(err, opts.auditOp ?? 'set');
    throw err;
  }

  if (opts.depository === 'env' && opts.scope === 'global') {
    const err = new EnigmaError({
      code: 'E_SCOPE_INVALID',
      message: 'env depository does not support global scope; a project .env file has no global location',
      secretName: opts.name,
    });
    auditRefusal(err, opts.auditOp ?? 'set');
    throw err;
  }

  const needsProjectPath = opts.scope === 'project' || opts.depository === 'env';
  const projectPath = needsProjectPath ? findProjectPath(opts.cwd ?? process.cwd()) : undefined;
  const pid = opts.scope === 'project' ? computeProjectId(opts.cwd ?? process.cwd()) : undefined;

  const index = readIndex();
  const existing = findIndexEntry(index, opts.name, opts.scope, pid);
  const op = opts.auditOp ?? (existing ? 'rotated' : 'set');

  if (existing && !opts.rotate) {
    const err = new EnigmaError({
      code: 'E_EXISTS',
      message: `${opts.name} already exists in ${opts.scope} scope; pass rotate to overwrite`,
      secretName: opts.name,
    });
    auditRefusal(err, op);
    throw err;
  }

  // env's ref is the bare NAME — the .env file is already located via DepositoryContext.projectPath (D1.9).
  const providedRef = opts.depository === 'env' ? opts.name : buildRef(opts.name, opts.scope, pid);
  const depository = createDepository(opts.depository, { projectPath, createVault: opts.createVault });

  let ref: string;
  try {
    ref = await depository.set(providedRef, opts.value);
  } catch (err) {
    auditRefusal(err, op);
    throw err;
  }

  const now = new Date().toISOString();
  const entry: IndexEntry = {
    name: opts.name,
    scope: opts.scope,
    projectId: pid,
    projectPath: opts.scope === 'project' ? projectPath : undefined,
    depository: opts.depository,
    ref,
    description: opts.description,
    usage: opts.usage,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeIndex(upsertIndexEntry(index, entry));
  appendAuditEvent({ op, name: opts.name, scope: opts.scope, depository: opts.depository, actor: opts.actor, ok: true, error: null });

  const warnings = opts.depository === 'env' && projectPath ? checkEnvGitignore(projectPath) : [];
  return { rotated: Boolean(existing), warnings };
}

export async function hasSecret(name: string, opts: { scope?: Scope | 'all'; cwd?: string } = {}): Promise<boolean> {
  const index = readIndex();
  const pid = opts.cwd ? computeProjectId(opts.cwd) : undefined;
  if (opts.scope && opts.scope !== 'all') {
    return Boolean(findIndexEntry(index, name, opts.scope, pid));
  }
  return Boolean(resolveIndexEntry(index, name, undefined, pid));
}

export function listSecrets(opts: { scope?: Scope | 'all'; cwd?: string } = {}): IndexEntryView[] {
  const index = readIndex();
  const currentProjectId = opts.cwd ? computeProjectId(opts.cwd) : undefined;
  return listIndexEntries(index, { scope: opts.scope, currentProjectId });
}

export interface DeleteSecretOptions {
  scope?: Scope;
  cwd?: string;
  actor: AuditActor;
}

export async function deleteSecret(name: string, opts: DeleteSecretOptions): Promise<void> {
  const pid = opts.cwd ? computeProjectId(opts.cwd) : undefined;
  const index = readIndex();
  const { index: updated, removed } = removeIndexEntry(index, name, opts.scope, pid);

  const depository = createDepository(removed.depository, { projectPath: projectPathFor(removed, opts.cwd) });
  try {
    await depository.delete(removed.ref);
  } catch (err) {
    appendAuditEvent({ op: 'remove', name, scope: removed.scope, depository: removed.depository, actor: opts.actor, ok: false, error: auditErrorText(err) });
    throw err;
  }

  writeIndex(updated);
  appendAuditEvent({ op: 'remove', name, scope: removed.scope, depository: removed.depository, actor: opts.actor, ok: true, error: null });
}

export interface ResolveSecretOptions {
  scope?: Scope;
  cwd?: string;
  actor: AuditActor;
  /** Audit op to record for this resolve; defaults to 'read'. The web reveal route (Issue #7) passes 'reveal' so a disclosure is audited as such rather than as a generic read. */
  auditOp?: AuditEvent['op'];
}

/**
 * @internal The only value-returning entry point above the depositories
 * (ADR-001). Callers are limited to `src/request/**`, `src/native/**`,
 * `src/hooks/tripwire.ts`, and `cli/commands/{run,get,reveal,move,import}`.
 */
export async function resolveSecret(name: string, opts: ResolveSecretOptions): Promise<string> {
  const pid = opts.cwd ? computeProjectId(opts.cwd) : undefined;
  const index = readIndex();
  const entry = resolveIndexEntry(index, name, opts.scope, pid);
  if (!entry) {
    throw new EnigmaError({ code: 'E_NOT_FOUND', message: `${name} not found`, secretName: name });
  }

  const op = opts.auditOp ?? 'read';
  const depository = createDepository(entry.depository, { projectPath: projectPathFor(entry, opts.cwd) });
  try {
    const value = await depository.resolve(entry.ref);
    appendAuditEvent({ op, name, scope: entry.scope, depository: entry.depository, actor: opts.actor, ok: true, error: null });
    return value;
  } catch (err) {
    appendAuditEvent({ op, name, scope: entry.scope, depository: entry.depository, actor: opts.actor, ok: false, error: auditErrorText(err) });
    throw err;
  }
}
