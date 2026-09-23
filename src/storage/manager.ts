// enigma:leak-fence-allow: storage manager is the sanctioned resolve path (ADR-001)
//
// Orchestrates naming validation, the index, audit logging, and depository
// dispatch. A secret value only ever passes through this file and
// src/storage/depositories/** (style-guide secret-handling conventions).

import { realpathSync } from 'node:fs';
import { EnigmaError } from '../core/errors.js';
import { validateName } from '../core/naming.js';
import { findProjectPath, projectId as computeProjectId } from '../core/project.js';
import { appendAuditEvent, auditErrorText, classifyCleanupError } from '../core/audit.js';
import type { AuditActor, AuditEvent, AuditRevealMethod } from '../core/audit.js';
import {
  buildRef,
  findIndexEntry,
  listIndexEntries,
  mutateIndex,
  readIndex,
  removeIndexEntry,
  resolveIndexEntry,
  upsertIndexEntry,
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

/**
 * Physical-directory identity for `env` storage locations (Issue #70): the
 * recorded `projectPath` is lexical, so two spellings of one directory
 * (e.g. a symlinked worktree path) must compare equal — a `.env` file is
 * one physical location however it was reached. Falls back to the lexical
 * path when realpath fails (e.g. the worktree is gone): a stale spelling
 * then simply differs from any live one, which is the safe direction.
 */
function canonicalPath(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * True when any current index entry still maps to `displaced`'s storage
 * location (Issue #70). Stable addresses are reusable: between our commit
 * and our cleanup delete, a concurrent rotate can legitimately repopulate
 * the same `(depository, ref)` — and for `env` the same `(projectPath,
 * NAME)` — and commit it as current. `readIndex()` without the lock is
 * enough: the index is written by atomic rename, so this always sees a
 * fully committed state, and no index state could make the delete safe
 * that a later commit couldn't invalidate anyway.
 */
function locationReclaimed(displaced: IndexEntry): boolean {
  return readIndex().entries.some(
    (e) =>
      e.depository === displaced.depository &&
      e.ref === displaced.ref &&
      (displaced.depository !== 'env' || canonicalPath(e.projectPath) === canonicalPath(displaced.projectPath)),
  );
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

  if (existing && !opts.rotate) {
    const err = new EnigmaError({
      code: 'E_EXISTS',
      message: `${opts.name} already exists in ${opts.scope} scope; pass rotate to overwrite`,
      secretName: opts.name,
    });
    // This refusal only ever fires when rotate was NOT requested (the condition above
    // requires it), so the request that reached it was always a plain set — never
    // 'rotated', the verb for having overwritten something, which never happened here
    // (PR #52 review: an audit line claiming more than the code delivered, just in a log
    // line instead of a comment).
    auditRefusal(err, opts.auditOp ?? 'set');
    throw err;
  }

  const op = opts.auditOp ?? (existing ? 'rotated' : 'set');

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

  // Issue #70: for prompt-free depositories, capture the displaced copy's
  // current value between the write and the index commit. The post-commit
  // cleanup may then delete the old location only while its content is
  // still this displaced copy — a stable address repopulated since (env's
  // `(projectPath, NAME)`, encrypted's `<id>/NAME`) must never be removed.
  // Prompting depositories (keychain, secret-service, 1password) get no
  // extra read: 1password's fresh item ids are unreusable by construction,
  // and a guarding read on the other two could prompt. 'empty' means the
  // old location was already absent at capture → nothing to delete.
  let capturedOld: { kind: 'value'; value: string } | { kind: 'empty' } | { kind: 'none' } = { kind: 'none' };
  if (existing && opts.rotate && existing.depository === opts.depository) {
    const oldDep = createDepository(existing.depository, { projectPath: projectPathFor(existing, opts.cwd) });
    if (oldDep.promptProfile === 'none') {
      try {
        capturedOld = { kind: 'value', value: await oldDep.resolve(existing.ref) };
      } catch (err) {
        if (err instanceof EnigmaError && err.code === 'E_NOT_FOUND') capturedOld = { kind: 'empty' };
      }
    }
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
  // Issue #70: the entry this write actually displaces — authoritative only
  // inside the lock, where the delta sees the post-acquire index. Captured
  // for the post-commit cleanup below; the pre-lock `existing` may be stale.
  let displaced: IndexEntry | undefined;
  try {
    mutateIndex((current) => {
      // Issue #66, AC #4/#5: re-read inside the lock so the delta sees the
      // authoritative state at the moment the lock was acquired. A concurrent
      // writer may have created an entry for this name/scope/projectId between
      // our pre-lock initial read and the lock acquire; if so we surface the
      // same E_EXISTS the pre-lock check would have. The depository write
      // already happened — a tight race here leaves an orphan value at
      // `entry.ref` that the index doesn't point at; this is a known
      // limitation called out in the PR body, and Issue #70 (rotate cleanup)
      // is where the cleanup story for same-name concurrent set is built.
      const currentExisting = findIndexEntry(current, opts.name, opts.scope, pid);
      if (currentExisting && !opts.rotate) {
        throw new EnigmaError({
          code: 'E_EXISTS',
          message: `${opts.name} already exists in ${opts.scope} scope; pass rotate to overwrite`,
          secretName: opts.name,
        });
      }
      displaced = currentExisting;
      return upsertIndexEntry(current, entry);
    });
  } catch (err) {
    auditRefusal(err, op);
    throw err;
  }
  appendAuditEvent({ op, name: opts.name, scope: opts.scope, depository: opts.depository, actor: opts.actor, ok: true, error: null });

  const warnings = opts.depository === 'env' && projectPath ? checkEnvGitignore(projectPath) : [];

  // Issue #70, D1.3: a same-depository rotate removes the displaced copy once
  // the index points at the new location. Best-effort — a cleanup failure
  // warns and audits like `move`'s (classifyCleanupError) but never fails the
  // rotate: the new value and index are already authoritative. Guards:
  //   - only when the old STORAGE LOCATION differs from the new one — a
  //     different ref, or for env a different physical projectPath (recorded
  //     projectPath is lexical; canonicalized here). Same-address writes
  //     already overwrote in place; deleting them would destroy the new value.
  //   - only when no committed index entry still references the old location
  //     (locationReclaimed): a concurrent rotate that repopulated and
  //     committed that address made it current again.
  //   - where the depository can compare content prompt-free (env, encrypted),
  //     only while the stored value is still the displaced copy captured
  //     before the commit (deleteIfUnchanged) — covering repopulation that
  //     lands between the commit and this delete.
  // Fresh-id depositories (1password) need none of the value guards. A
  // different-depository rotate is `move`'s domain and stays untouched.
  if (displaced && displaced.depository === opts.depository) {
    const locationDiffers =
      displaced.ref !== ref ||
      (opts.depository === 'env' && canonicalPath(displaced.projectPath) !== canonicalPath(projectPath));
    if (locationDiffers && !locationReclaimed(displaced)) {
      const oldDep = createDepository(displaced.depository, { projectPath: projectPathFor(displaced, opts.cwd) });
      const capturedForDisplaced =
        existing !== undefined &&
        displaced.ref === existing.ref &&
        (opts.depository !== 'env' || canonicalPath(displaced.projectPath) === canonicalPath(existing.projectPath));
      try {
        if (capturedOld.kind === 'empty' && capturedForDisplaced) {
          // Already absent at capture — nothing to delete.
        } else if (capturedOld.kind === 'value' && capturedForDisplaced && oldDep.deleteIfUnchanged) {
          await oldDep.deleteIfUnchanged(displaced.ref, capturedOld.value);
        } else {
          await oldDep.delete(displaced.ref);
        }
      } catch (err) {
        warnings.push(
          `could not remove the old copy of ${opts.name} in ${opts.depository} (cleanup failed: ${classifyCleanupError(err)})`,
        );
        appendAuditEvent({ op: 'remove', name: opts.name, scope: opts.scope, depository: opts.depository, actor: opts.actor, ok: false, error: classifyCleanupError(err) });
      }
    }
  }

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
  const { removed } = removeIndexEntry(index, name, opts.scope, pid);

  const depository = createDepository(removed.depository, { projectPath: projectPathFor(removed, opts.cwd) });
  try {
    await depository.delete(removed.ref);
  } catch (err) {
    appendAuditEvent({ op: 'remove', name, scope: removed.scope, depository: removed.depository, actor: opts.actor, ok: false, error: auditErrorText(err) });
    throw err;
  }

  try {
    mutateIndex((current) => {
      // Issue #66 (PR #77 review): remove exactly the entry we resolved and
      // deleted from the depository before the await — matched by
      // name+scope+projectId AND ref, not a fresh scope resolution. A fresh
      // `resolveIndexEntry(current, name, opts.scope, pid)` re-applies D1.5
      // shadowing against the *current* index: if a same-name project
      // `setSecret` committed during the `depository.delete` await, an
      // omitted-scope global delete would resolve to (and remove) that new
      // project entry instead of refusing, leaving the just-deleted global
      // entry dangling. Matching the original entry's identity, including
      // `ref`, ensures we only ever remove the entry that was actually
      // deleted — never guess at a different one.
      const currentRemoved = findIndexEntry(current, removed.name, removed.scope, removed.projectId);
      if (!currentRemoved || currentRemoved.ref !== removed.ref) {
        throw new EnigmaError({ code: 'E_NOT_FOUND', message: `${name} not found`, secretName: name });
      }
      return { ...current, entries: current.entries.filter((e) => e !== currentRemoved) };
    });
  } catch (err) {
    appendAuditEvent({ op: 'remove', name, scope: removed.scope, depository: removed.depository, actor: opts.actor, ok: false, error: auditErrorText(err) });
    throw err;
  }
  appendAuditEvent({ op: 'remove', name, scope: removed.scope, depository: removed.depository, actor: opts.actor, ok: true, error: null });
}

export interface ResolveSecretOptions {
  scope?: Scope;
  cwd?: string;
  actor: AuditActor;
  /** Audit op to record for this resolve; defaults to 'read'. The web reveal route (Issue #7) passes 'reveal' so a disclosure is audited as such rather than as a generic read. */
  auditOp?: AuditEvent['op'];
  /** Disclosure surface to record when `auditOp` is 'reveal' (Issue #26); ignored for every other op. */
  auditMethod?: AuditRevealMethod;
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
  const method = op === 'reveal' ? opts.auditMethod : undefined;
  const depository = createDepository(entry.depository, { projectPath: projectPathFor(entry, opts.cwd) });
  try {
    const value = await depository.resolve(entry.ref);
    appendAuditEvent({ op, name, scope: entry.scope, depository: entry.depository, actor: opts.actor, ok: true, error: null, method });
    return value;
  } catch (err) {
    appendAuditEvent({ op, name, scope: entry.scope, depository: entry.depository, actor: opts.actor, ok: false, error: auditErrorText(err), method });
    throw err;
  }
}
