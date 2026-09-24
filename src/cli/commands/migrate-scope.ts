// `enigma migrate-scope` (Issue #72, plan Decision 2): re-keys project-scope
// index entries recorded before `projectId` became the canonical repository
// identity (Issue #67). INDEX-ONLY: it rewrites `projectId`, never resolves a
// value, and never calls a depository — nothing here imports the storage
// layer. Output is names, depository ids, paths, and classes only.
import { parseArgs, UsageError } from '../args.js';
import { appendAuditEvent, auditErrorText } from '../../core/audit.js';
import { classifyLegacyScopeEntries, migrateScope, readIndex } from '../../core/index-store.js';
import type { IndexEntry, LegacyScopeItem } from '../../core/index-store.js';

const USAGE = 'enigma migrate-scope [--from PATH] [--apply] [--prune-unrecoverable]';

const HELP = `${USAGE}

Re-keys project-scope index entries recorded before projectId became the
canonical repository identity: entries saved from a linked worktree, a
symlinked clone path, or a submodule are invisible until re-keyed. The
migration is index-only — it rewrites projectId, never resolves a value,
and never calls a depository.

Dry run by default: prints name, depository, recorded projectPath,
classification, and the target repo. --apply performs the plan under one
index lock and writes one 'migrate' audit line per re-keyed entry.

Classes:
  adoptable               recorded projectPath still exists and belongs to
                          this repo — re-keyed.
  orphaned-adoptable      projectPath gone; the value lives outside the
                          worktree — re-keyed only when --from PATH names
                          the recorded projectPath. The match is lexical:
                          the path no longer exists, so your attest is the
                          only check.
  orphaned-unrecoverable  projectPath gone and depository is env — the
                          value is gone; re-request the name. Only
                          --prune-unrecoverable removes the entry (audit
                          op 'remove').
  conflict                the name already exists at repo scope, or two
                          legacy entries share it — skipped and named,
                          never overwritten; re-runnable after you resolve
                          it.

Exit codes: 0 when nothing actionable remains (always for a dry run);
1 when conflicts or unadopted orphans remain after --apply; 2 usage.
`;

function recordedPath(entry: IndexEntry): string {
  return entry.projectPath ?? '(no recorded projectPath)';
}

function planLine(item: LegacyScopeItem): string {
  const e = item.entry;
  return `  ${item.class.padEnd(22)} ${e.name}  ${e.depository}  ${recordedPath(e)}${item.detail ? ` — ${item.detail}` : ''}`;
}

function appliedLine(verb: string, e: IndexEntry, detail?: string): string {
  return `  ${verb.padEnd(22)} ${e.name}  ${e.depository}  ${recordedPath(e)}${detail ? ` — ${detail}` : ''}`;
}

export async function cmdMigrateScope(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, {
    value: ['from'],
    boolean: ['apply', 'prune-unrecoverable', 'help'],
  });
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (positionals.length > 0) throw new UsageError(USAGE);

  const apply = Boolean(flags.apply);
  const pruneUnrecoverable = Boolean(flags['prune-unrecoverable']);
  const from = typeof flags.from === 'string' ? flags.from : undefined;
  const cwd = process.cwd();

  const plan = classifyLegacyScopeEntries(readIndex(), { cwd, from });

  if (plan.items.length === 0) {
    process.stdout.write('No legacy project-scope entries found for this repository.\n');
    return 0;
  }

  const header = [
    `Target repo: ${plan.identityPath} (projectId ${plan.projectId})`,
    ...plan.items.map(planLine),
    `Summary: ${plan.counts.adoptable} adoptable, ${plan.counts['orphaned-adoptable']} orphaned-adoptable, ${plan.counts['orphaned-unrecoverable']} orphaned-unrecoverable, ${plan.counts.conflict} conflict`,
  ];
  // A --from that attested nothing is almost certainly a typo'd path — say so.
  const fromUnmatched =
    from !== undefined && !plan.items.some((i) => i.class === 'orphaned-adoptable' && i.rekeyable)
      ? [`Note: --from ${from} matched no orphaned entry's recorded projectPath.`]
      : [];

  if (!apply) {
    process.stdout.write(`${['enigma migrate-scope — dry run (no changes; re-run with --apply)', ...header, ...fromUnmatched].join('\n')}\n`);
    return 0;
  }

  let result: ReturnType<typeof migrateScope>;
  try {
    result = migrateScope({ cwd, from, pruneUnrecoverable });
  } catch (err) {
    // The batch failed as a whole (e.g. E_LOCK_TIMEOUT): audit one refused
    // 'migrate' per entry the plan intended to re-key, same shape as
    // setSecret's auditRefusal — a refusal that left the world unchanged is
    // still an operation worth recording.
    for (const item of plan.items) {
      if (item.rekeyable) {
        // Issue #80: attributes the refused re-key to the entry's recorded
        // project — a legacy id is still that entry's identity until it is
        // re-keyed. `plan.projectId` is only the fallback for a legacy entry
        // that lacks the field entirely.
        appendAuditEvent({
          op: 'migrate',
          name: item.entry.name,
          scope: 'project',
          projectId: item.entry.projectId ?? plan.projectId,
          projectPath: item.entry.projectPath,
          depository: item.entry.depository,
          actor: 'cli',
          ok: false,
          error: auditErrorText(err),
        });
      }
    }
    throw err;
  }

  for (const e of result.rekeyed) {
    // e.projectId is already the re-keyed repo id; the ?? fallback is only
    // for the impossible-in-practice missing field.
    appendAuditEvent({ op: 'migrate', name: e.name, scope: 'project', projectId: e.projectId ?? plan.projectId, projectPath: e.projectPath, depository: e.depository, actor: 'cli', ok: true, error: null });
  }
  for (const e of result.pruned) {
    appendAuditEvent({ op: 'remove', name: e.name, scope: 'project', projectId: e.projectId ?? plan.projectId, projectPath: e.projectPath, depository: e.depository, actor: 'cli', ok: true, error: null });
  }

  const lines = [
    'enigma migrate-scope — applied',
    ...header,
    ...result.rekeyed.map((e) => appliedLine('re-keyed', e)),
    ...result.pruned.map((e) => appliedLine('pruned', e)),
    ...result.conflicts.map((e) => appliedLine('skipped', e, 'conflict — resolve and re-run')),
    ...result.pendingOrphans.map((e) => appliedLine('left', e, 'needs --from to attest membership')),
    ...result.unrecoverable.map((e) => appliedLine('left', e, `value is gone; re-request ${e.name}`)),
    ...fromUnmatched,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);

  return result.conflicts.length > 0 || result.pendingOrphans.length > 0 ? 1 : 0;
}
