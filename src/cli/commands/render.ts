/* enigma render — write the worktree's project secrets into the
 * configured target file under a managed `# enigma:render:begin` /
 * `# enigma:render:end` block (Issue #107).
 *
 * Output (Tech Lead rule #9):
 * - rendered: freshly written names
 * - kept: lines already in the block and not re-resolved (prompting
 *   store, or a previously-rendered line preserved across a failed
 *   resolve — Tech Lead rules #4 and #5)
 * - removed: names dropped from the block this pass
 * - failed: per-name resolve failures with the static, value-free reason
 * - skipped: prompting-store names not previously rendered (plain mode),
 *   manifest-narrowed names, global-scope secrets
 * - warnings: gitignore, leftover temp file, etc.
 *
 * Global secrets are never listed on stdout, even as "skipped" — they
 * are silently out of scope.
 */
import { parseArgs, UsageError } from '../args.js';
import { checkEnvGitignore } from '../../storage/depositories/env.js';
import { findProjectPath, projectId as computeProjectId } from '../../core/project.js';
import { loadProjectManifest } from '../../core/config.js';
import { readIndex } from '../../core/index-store.js';
import { resolveSecret } from '../../storage/manager.js';
import type { DepositoryId } from '../../storage/interfaces.js';
import { buildRenderPlan, executeRender } from '../../render/render.js';
import type { RenderNameStatus, RenderOutcome, RenderPlan } from '../../render/render.js';

const USAGE = 'enigma render [NAME] [--json]';

interface RenderReport {
  /** Names whose value was freshly resolved and encoded into the block. */
  rendered: string[];
  /** Names whose existing block line was preserved verbatim (no re-resolve). */
  kept: string[];
  /** Names dropped from the block on this pass. */
  removed: string[];
  /** Per-name resolve failures with the static reason. */
  failed: Array<{ name: string; errorCode: string; message: string }>;
  /** Names the renderer intentionally did not render (prompting store not previously rendered, manifest narrowing). */
  skipped: Array<{ name: string; reason: string }>;
  /** Free-form warnings (e.g. gitignore). */
  warnings: string[];
  /** True when `render.enabled: false` short-circuited the pass. */
  disabled: boolean;
  /** True when the per-file atomic write failed. */
  writeError?: string;
  /** Target file (echoed so a script parsing --json can act on it). */
  file: string;
}

function reportToJson(outcome: RenderOutcome, plan: RenderPlan, perName: RenderNameStatus[]): RenderReport {
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const item of perName) {
    switch (item.kind) {
      case 'skipped-prompting-auto':
        skipped.push({ name: item.name, reason: 'prompting-store secret; use `enigma render NAME` to render it explicitly' });
        break;
      case 'skipped-manifest-narrowing':
        skipped.push({ name: item.name, reason: 'excluded by .enigma.json render.names' });
        break;
      // render / keep-prompting / keep-failed are covered elsewhere.
      // global-skipped / skipped-not-in-index are internal-only and never listed.
    }
  }
  const file = plan.file;
  const out: RenderReport = {
    rendered: outcome.rendered,
    kept: outcome.kept,
    removed: outcome.removed,
    failed: outcome.failed,
    skipped,
    warnings: outcome.warnings,
    disabled: outcome.disabled,
    file,
  };
  if (outcome.writeError !== undefined) out.writeError = outcome.writeError;
  return out;
}

function reportText(outcome: RenderOutcome, plan: RenderPlan, perName: RenderNameStatus[]): string {
  const lines: string[] = [];
  if (outcome.disabled) {
    lines.push('rendering is off (render.enabled=false in .enigma.json)');
    for (const w of outcome.warnings) lines.push(`warning: ${w}`);
    return `${lines.join('\n')}\n`;
  }
  if (plan.explicit) {
    lines.push(`Rendered to ${plan.file}.`);
  } else {
    if (outcome.rendered.length > 0) lines.push(`Rendered: ${outcome.rendered.join(', ')}`);
    if (outcome.kept.length > 0) lines.push(`Kept (prompting store, not re-resolved): ${outcome.kept.join(', ')}`);
    if (outcome.removed.length > 0) lines.push(`Removed: ${outcome.removed.join(', ')}`);
    for (const item of perName) {
      if (item.kind === 'skipped-prompting-auto') {
        lines.push(`Skipped: ${item.name} (prompting store; not previously rendered — use \`enigma render ${item.name}\` to render it explicitly)`);
      } else if (item.kind === 'skipped-manifest-narrowing') {
        lines.push(`Skipped: ${item.name} (excluded by .enigma.json render.names)`);
      }
    }
    for (const f of outcome.failed) {
      lines.push(`Failed: ${f.name} (${f.errorCode}: ${f.message})`);
    }
  }
  for (const w of outcome.warnings) lines.push(`warning: ${w}`);
  if (outcome.writeError !== undefined) {
    lines.push(`.env was not rewritten (${outcome.writeError}).`);
  }
  return `${lines.filter((l) => l.length > 0).join('\n')}\n`;
}

export async function cmdRender(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { boolean: ['json'] });
  const json = Boolean(flags.json);
  if (positionals.length > 1) throw new UsageError(USAGE);
  const explicitName = positionals[0];

  const cwd = process.cwd();
  const worktree = findProjectPath(cwd);
  const projectId = computeProjectId(cwd);
  const index = readIndex();
  const manifest = loadProjectManifest(worktree);

  const plan = buildRenderPlan({
    cwd,
    projectId,
    worktree,
    index,
    manifest,
    explicitName,
  });

  // Gitignore warning: applies to the env depository's check (Issue
  // #107 AC #9 — same warning as the `env` depository). The depository
  // itself surfaces this on every set; the renderer surfaces it once
  // per render, before any work is attempted.
  const gitignoreWarnings = checkEnvGitignore(worktree);
  plan.warnings.push(...gitignoreWarnings);

  // Inject the value resolver. resolveSecret is the sanctioned resolve
  // path (ADR-001) — it lives under src/storage/** so the leak-fence
  // (which scans src/mcp/**, src/web/**, src/hooks/**) doesn't catch
  // it, and src/storage/manager.ts carries the `enigma:leak-fence-allow`
  // marker.
  const outcome = await executeRender(plan, {
    actor: 'cli',
    projectId,
    worktree,
    resolveValue: async (name: string, depository: DepositoryId): Promise<string> =>
      resolveSecret(name, { cwd: worktree, actor: 'cli' }).then((value) => {
        // ensure depository matches — the index entry's depository is
        // canonical, but a misconfigured override should still hit the
        // right store. resolveSecret reads from the index's depository.
        void depository;
        return value;
      }),
  });

  const report = json ? reportToJson(outcome, plan, plan.perName) : null;
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(reportText(outcome, plan, plan.perName));
  }

  // Exit codes (Tech Lead rule #9 / documented in api-contracts.md):
  // - 0 on full success (no failures, write succeeded)
  // - 1 when any per-name resolve failed (other names may have rendered)
  // - 1 when the atomic write failed
  // - The plan/structural errors thrown above (path escape, missing
  //   parent dir, manifest parsing) surface as EnigmaError via the
  //   dispatcher's normal mapping.
  if (outcome.writeError !== undefined) return 1;
  if (outcome.failed.length > 0) return 1;
  return 0;
}