/* enigma render — write the worktree's project secrets into the
 * configured target file under a managed `# enigma:render:begin` /
 * `# enigma:render:end` block (Issue #107).
 *
 * Output (names, static reasons and paths only; never a value):
 * - Rendered: names freshly written
 * - Kept: names whose existing line was copied as bytes, not re-resolved
 * - Removed: names dropped from the block this pass (includes names
 *   narrowed out by `render.names` that had been rendered)
 * - Already in the env block: names that are in this file's `# enigma:begin`
 *   block and therefore never written into the render block
 * - Skipped: prompting-store names never rendered; names narrowed out that
 *   were never rendered
 * - Failed: per-name failure with a static reason; "kept previous line"
 *   when the name's old line survived
 * - warnings: gitignore for the configured target, leftover temp file
 *
 * Global secrets are never listed, even as "skipped": they are out of scope.
 * Exit code: 0 on full success; 1 on any Failed name or a failed write;
 * a structural refusal or a malformed `render` key throws an EnigmaError
 * (the dispatcher prints it to stderr and exits 1).
 */
import { relative } from 'node:path';
import { parseArgs, UsageError } from '../args.js';
import { checkEnvGitignore } from '../../storage/depositories/env.js';
import { findProjectPath, projectId as computeProjectId } from '../../core/project.js';
import { loadProjectManifest } from '../../core/config.js';
import { EnigmaError } from '../../core/errors.js';
import { readIndex } from '../../core/index-store.js';
import { resolveSecret } from '../../storage/manager.js';
import { buildRenderPlan, executeRender } from '../../render/render.js';
import type { RenderFailure, RenderOutcome, RenderSkip } from '../../render/render.js';

const USAGE = 'enigma render [NAME] [--json]';

const SKIP_REASONS: Record<RenderSkip['reason'], string> = {
  'prompting-store': 'prompting store, not previously rendered; use `enigma render NAME` to render it explicitly',
  'narrowed-out': 'excluded by .enigma.json render.names',
};

interface RenderReport {
  rendered: string[];
  kept: string[];
  removed: string[];
  failed: RenderFailure[];
  alreadyInEnvBlock: string[];
  skipped: Array<{ name: string; reason: string }>;
  warnings: string[];
  disabled: boolean;
  writeError?: string;
  file: string;
}

function reportToJson(outcome: RenderOutcome): RenderReport {
  const report: RenderReport = {
    rendered: outcome.rendered,
    kept: outcome.kept,
    removed: outcome.removed,
    failed: outcome.failed,
    alreadyInEnvBlock: outcome.alreadyInEnvBlock,
    skipped: outcome.skipped.map((s) => ({ name: s.name, reason: SKIP_REASONS[s.reason] })),
    warnings: outcome.warnings,
    disabled: outcome.disabled,
    file: outcome.file,
  };
  if (outcome.writeError !== undefined) report.writeError = outcome.writeError;
  return report;
}

function failedLine(f: RenderFailure): string {
  return `Failed: ${f.name} (${f.errorCode}: ${f.reason}${f.keptPreviousLine ? '; kept previous line' : ''})`;
}

function reportText(outcome: RenderOutcome, explicitName: string | undefined): string {
  const lines: string[] = [];
  if (outcome.disabled) {
    lines.push('rendering is off (render.enabled=false in .enigma.json)');
  } else if (explicitName !== undefined) {
    // The success line appears only when the line was actually written.
    if (outcome.rendered.includes(explicitName)) lines.push(`Rendered ${explicitName} to ${outcome.file}.`);
    if (outcome.alreadyInEnvBlock.includes(explicitName)) {
      lines.push(`${explicitName} is already in the env block of ${outcome.file}; not written to the render block.`);
    }
    for (const f of outcome.failed) lines.push(failedLine(f));
  } else {
    if (outcome.rendered.length > 0) lines.push(`Rendered: ${outcome.rendered.join(', ')}`);
    if (outcome.kept.length > 0) lines.push(`Kept (prompting store, not re-resolved): ${outcome.kept.join(', ')}`);
    if (outcome.removed.length > 0) lines.push(`Removed: ${outcome.removed.join(', ')}`);
    if (outcome.alreadyInEnvBlock.length > 0) lines.push(`Already in the env block: ${outcome.alreadyInEnvBlock.join(', ')}`);
    for (const s of outcome.skipped) lines.push(`Skipped: ${s.name} (${SKIP_REASONS[s.reason]})`);
    for (const f of outcome.failed) lines.push(failedLine(f));
    if (lines.length === 0 && outcome.writeError === undefined) lines.push('Nothing to render.');
  }
  for (const w of outcome.warnings) lines.push(`warning: ${w}`);
  if (outcome.writeError !== undefined) lines.push(`${outcome.file} was not rewritten (${outcome.writeError}).`);
  return `${lines.join('\n')}\n`;
}

export async function cmdRender(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { boolean: ['json'] });
  const json = Boolean(flags.json);
  if (positionals.length > 1) throw new UsageError(USAGE);
  const explicitName = positionals[0];

  const cwd = process.cwd();
  const worktree = findProjectPath(cwd);
  const projectId = computeProjectId(cwd);
  const manifest = loadProjectManifest(worktree);
  // A malformed `render` key is acted on here only; `loadProjectManifest`
  // carries it so `set`, `list` and the rest keep working.
  if (manifest.renderError !== undefined) {
    throw new EnigmaError({ code: 'E_CONFIG_CORRUPT', message: `.enigma.json: ${manifest.renderError}; fix it, then run \`enigma render\` again.` });
  }

  const plan = buildRenderPlan({ cwd, projectId, worktree, index: readIndex(), manifest, explicitName });
  // Gitignore check for the configured target, not always `.env`.
  plan.warnings.push(...checkEnvGitignore(worktree, relative(worktree, plan.file)));

  // `resolveSecret` is the sanctioned resolve path (ADR-001); it lives under
  // src/storage/**, outside the leak-fence's scan of src/mcp/** and src/web/**.
  const outcome = await executeRender(plan, {
    actor: 'cli',
    projectId,
    worktree,
    resolveValue: (name) => resolveSecret(name, { cwd: worktree, actor: 'cli' }),
  });

  process.stdout.write(json ? `${JSON.stringify(reportToJson(outcome))}\n` : reportText(outcome, explicitName));

  return outcome.writeError !== undefined || outcome.failed.length > 0 ? 1 : 0;
}
