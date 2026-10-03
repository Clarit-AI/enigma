import { parseArgs, parseScope, UsageError } from '../args.js';
import { locationReclaimed, resolveSecret, setSecret } from '../../storage/manager.js';
import { reconcileAfterCommit } from '../../render/fanout.js';
import { findProjectPath } from '../../core/project.js';
import { readIndex, resolveIndexEntry } from '../../core/index-store.js';
import { projectId as computeProjectId } from '../../core/project.js';
import { appendAuditEvent, auditErrorText, auditScopeFields, classifyCleanupError } from '../../core/audit.js';
import { DEPOSITORY_MODULES } from '../../storage/detect.js';
import { EnigmaError } from '../../core/errors.js';
import type { DepositoryId } from '../../storage/interfaces.js';

const USAGE = 'enigma move NAME --to ID [--scope project|global]';

export async function cmdMove(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { value: ['to', 'scope'] });
  const [name] = positionals;
  const to = flags.to;
  if (!name || typeof to !== 'string') throw new UsageError(USAGE);
  const target = to as DepositoryId;

  const scopeFlag = parseScope(flags.scope);
  const cwd = process.cwd();
  const pid = computeProjectId(cwd);
  const entry = resolveIndexEntry(readIndex(), name, scopeFlag, pid);
  if (!entry) {
    throw new EnigmaError({ code: 'E_NOT_FOUND', message: `${name} not found`, secretName: name });
  }

  if (entry.depository === target) {
    process.stdout.write(`${name} is already in ${target}\n`);
    return 0;
  }

  let value: string;
  try {
    value = await resolveSecret(name, { scope: entry.scope, cwd, actor: 'cli' });
  } catch (err) {
    // resolveSecret is not setSecret's concern — nothing else audits this step, so it's
    // audited here, same as before.
    appendAuditEvent({ op: 'move', name, depository: target, actor: 'cli', ok: false, error: auditErrorText(err), ...auditScopeFields(entry) });
    throw err;
  }

  // setSecret now audits every refusal/failure path it owns itself (Issue #39), for both
  // ok:false and ok:true. Passing auditOp: 'move' makes that one line carry the right verb
  // and covers this whole step end to end — wrapping it in another catch here (as before)
  // would double-log the identical event under two labels (PR #52 review).
  //
  // Issue #108: the render fan-out is suppressed here and run LAST, after the old copy is gone, so it
  // reconciles against what the move really left on disk (an env -> encrypted move must see the env line
  // already removed, or the origin worktree ends with no definition at all).
  const result = await setSecret({
    name,
    value,
    scope: entry.scope,
    depository: target,
    cwd,
    description: entry.description,
    usage: entry.usage,
    rotate: true,
    actor: 'cli',
    auditOp: 'move',
    skipRenderFanout: true,
  });
  const warnings = [...result.warnings];

  // Best-effort cleanup of the old value; the index already points at the new depository. Never delete an old
  // location the index still references: a newer commit may have reused it (a stable address such as encrypted's
  // `<id>/NAME` or env's bare NAME), and deleting it would lose the value that commit stored.
  const oldModule = DEPOSITORY_MODULES.find((m) => m.id === entry.depository);
  if (oldModule) {
    if (locationReclaimed(entry)) {
      warnings.push(`left the old copy of ${name} in ${entry.depository} in place: a newer change to ${name} uses that location`);
    } else {
      const projectPath = entry.scope === 'project' ? entry.projectPath : undefined;
      const oldDep = oldModule.create({ projectPath });
      // Compare-and-delete where the depository can do it prompt-free: only the copy this move read.
      const cleanup = oldDep.deleteIfUnchanged ? oldDep.deleteIfUnchanged(entry.ref, value) : oldDep.delete(entry.ref);
      await cleanup.catch((err: unknown) => {
        // Issue #22, AC #5: name the depository and the orphaned ref, never the value.
        process.stderr.write(
          `Warning: orphaned ref ${entry.ref} in ${entry.depository} (best-effort cleanup failed: ${classifyCleanupError(err)})\n`,
        );
      });
    }
  }

  // Issue #108: now reconcile rendered copies. A worktree whose own env block held NAME (an env -> no-prompt move)
  // just lost that line, so it gains a render line to keep the variable defined.
  if (entry.scope === 'project' && entry.projectId !== undefined) {
    const lostEnvLine = entry.depository === 'env' && entry.projectPath !== undefined && target !== 'env';
    const fanned = await reconcileAfterCommit({
      name,
      value,
      projectId: entry.projectId,
      worktree: findProjectPath(cwd),
      depository: target,
      commit: result.commit,
      actor: 'cli',
      isNew: false,
      moved: true,
      restoreWorktree: lostEnvLine ? entry.projectPath : undefined,
    });
    for (const w of fanned) if (!warnings.includes(w)) warnings.push(w);
  }

  process.stdout.write(`Moved ${name} to ${target} (${entry.scope})\n`);
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  return 0;
}
