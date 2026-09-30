/* ------------------------------------------------------------------ *
 *  Renderer (Issue #107)                                              *
 * ------------------------------------------------------------------ *
 *
 * Writes the worktree's managed render block into the configured target
 * file (default `.env`), preserving everything outside the block byte-
 * for-byte, under a per-target lock from Issue #106, with the result
 * reflected in the names-only render ledger (`src/render/ledger.ts`).
 *
 * The split between `buildRenderPlan` and `executeRender` keeps the
 * rendering core names-only by construction — `RenderPlan` carries no
 * values (Tech Lead rule #2), so even if the plan is logged or persisted
 * by a future surface, no value ever lands in it. Values are resolved
 * one name at a time inside `executeRender` via the injected
 * `resolveValue` callback, immediately before they are encoded into a
 * single line of the new block. After the line is on disk, the value
 * variable goes out of scope; nothing in this module retains it.
 *
 * Wiring outside `src/mcp/**` and `src/web/**` (ADR-001, leak-fence).
 * The `resolveValue` callback in production is `resolveSecret` from
 * `src/storage/manager.ts`, which is the sanctioned resolve path
 * (`enigma:leak-fence-allow` on that file). Tests inject a stub
 * `resolveValue` to assert the sentinel stays in the file only.
 *
 * Decisions of record (Issue #107 settled design + the 9 plan-binding
 * rules from the Tech Lead):
 *
 * - Render set (plain `enigma render`): project-scoped entries for this
 *   repo whose depository's prompt profile is `none` (`encrypted`,
 *   `env`). Global entries are excluded. `render.names` narrows.
 * - Explicit `enigma render NAME`: MERGES — adds/updates only NAME's
 *   line, leaves every other line byte-identical.
 * - A previously-rendered line whose entry is now in a PROMPTING
 *   depository (keychain/secret-service/1password) is KEPT verbatim and
 *   NOT re-resolved on a later plain render — the prompt is a
 *   per-intent human interaction, not a refresh on every CLI call.
 * - A previously-rendered line whose entry has been removed, demoted to
 *   global, or excluded by `render.names` / `render.enabled` is DROPPED
 *   from the block on the next plain render.
 * - A failed resolve: if the block already has a line for that name,
 *   keep that line verbatim. Report by name with a static reason. Other
 *   names still render. Exit non-zero.
 * - Block appended at EOF, after any existing env block. The file's EOL
 *   style and trailing newline are preserved.
 * - The target path is always resolved relative to the worktree root
 *   that drives `computeProjectId` (the `worktree` arg). Absolute paths
 *   are refused. Lexical escapes (`..`) are refused. A parent dir whose
 *   realpath is outside the worktree's realpath is refused (symlink
 *   escape). A missing parent dir is refused; we never create dirs in
 *   the user's worktree.
 * - Audit: one `render` line per name, names only, with the worktree
 *   path attributed via `auditScopeFields`. Per-name failures audit
 *   `ok: false` with a static, value-free reason.
 */
import { chmodSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { appendAuditEvent, auditErrorText, auditScopeFields } from '../core/audit.js';
import type { AuditActor } from '../core/audit.js';
import { acquireFileLock } from '../core/file-lock.js';
import { EnigmaError } from '../core/errors.js';
import { renderLockPath } from '../core/paths.js';
import { writeFileAtomic } from '../core/secure-file.js';
import type { IndexFile } from '../core/index-store.js';
import type { ProjectManifest } from '../core/config.js';
import type { DepositoryId, PromptProfile } from '../storage/interfaces.js';
import { DEPOSITORY_MODULES } from '../storage/detect.js';
import { replaceTarget } from './ledger.js';
import { RENDER_BEGIN_MARKER, RENDER_END_MARKER, encodeValue, readManagedBlockLines, writeManagedBlock } from '../storage/dotenv-file.js';

const RENDER_BLOCK_MARKERS = { begin: RENDER_BEGIN_MARKER, end: RENDER_END_MARKER } as const;
const FILE_MODE = 0o600;
const DEFAULT_RENDER_PATH = '.env';
const PATH_TRAVERSAL_SEGMENT_RE = /(^|[/\\])\.\.([/\\]|$)/;

/* ----------------------------- types ------------------------------- */

/**
 * One name's status in the build-time plan. The plan carries no values:
 * a `value` field does not exist here, so even a serialised plan can
 * never reach a secret's bytes (Tech Lead rule #2). A `keptLine` is the
 * raw `NAME=encoded-value` text already in the file, copied verbatim —
 * it is opaque bytes, never parsed to a value here.
 */
export type RenderNameStatus =
  | { kind: 'render'; name: string; depository: DepositoryId }
  | { kind: 'keep-prompting'; name: string; depository: DepositoryId; line: string }
  | { kind: 'keep-failed'; name: string; depository: DepositoryId; line: string; errorCode: string; message: string }
  | { kind: 'skipped-global'; name: string }
  | { kind: 'skipped-manifest-narrowing'; name: string }
  | { kind: 'skipped-prompting-auto'; name: string; depository: DepositoryId }
  | { kind: 'skipped-not-in-index'; name: string }
  | { kind: 'failed'; name: string; depository: DepositoryId; errorCode: string; message: string };

/** A name that needs a fresh value resolved before the block is written. */
export interface RenderToWrite {
  name: string;
  depository: DepositoryId;
}

/** A name whose existing block line is copied verbatim (no prompt, no re-resolve). */
export interface RenderToKeep {
  name: string;
  /** Raw `NAME=encoded-value` line as it appears in the existing block — bytes only. */
  line: string;
}

/**
 * One render pass: who to render, who to keep, who to drop, and where the
 * output goes. The plan is NAMES-ONLY; a value never enters this object.
 * `previousRenderedNames` is the ledger's view of what was in the block
 * last time, used to detect "previously rendered, now dropped" cases.
 */
export interface RenderPlan {
  enabled: boolean;
  /** Absolute worktree root the target file lives under. */
  worktree: string;
  /** Absolute path of the target file (e.g. `<worktree>/.env`). */
  file: string;
  /** True when the target file did not exist before this render — used by executeRender to set initial mode. */
  fileIsNew: boolean;
  /** Names in scope for this render, in the order they will appear in the block. */
  finalNames: string[];
  /** Names whose line must be freshly encoded (one resolveValue call each). */
  toWrite: RenderToWrite[];
  /** Existing lines copied verbatim. */
  toKeep: RenderToKeep[];
  /** Names to drop (in the previous ledger but not in `finalNames`). */
  toRemove: string[];
  /** Per-name outcome for stdout. The renderer iterates this directly. */
  perName: RenderNameStatus[];
  /** Warnings to surface (e.g. `checkEnvGitignore`). Never a value. */
  warnings: string[];
  /** True when the plan was built for an explicit `enigma render NAME`. */
  explicit: boolean;
}

/* ----------------------------- helpers ----------------------------- */

const PROMPT_PROFILE_BY_DEPOSITORY = new Map<DepositoryId, PromptProfile>(
  DEPOSITORY_MODULES.map((m) => [m.id, m.promptProfile]),
);

function promptProfileFor(depository: DepositoryId): PromptProfile | undefined {
  return PROMPT_PROFILE_BY_DEPOSITORY.get(depository);
}

/** Strip a `NAME=…` line to the bare name. Used to map a kept line to its index name. */
function nameFromLine(line: string): string | undefined {
  const eq = line.indexOf('=');
  if (eq <= 0) return undefined;
  return line.slice(0, eq);
}

/**
 * Validate `renderPath` against the worktree. Tech Lead rule #7:
 * - absolute → E_WRITE_FAILED.
 * - lexical escape (`..` segment) → E_WRITE_FAILED.
 * - parent dir missing → E_WRITE_FAILED.
 * - parent dir's realpath outside worktree realpath → E_WRITE_FAILED.
 *
 * Names-only messages, never echoing the path back through to a leaky
 * surface (the path is internal but its message is also names-only by
 * project convention).
 */
function resolveRenderTarget(worktree: string, renderPath: string): { file: string; exists: boolean } {
  if (isAbsolute(renderPath)) {
    throw new EnigmaError({
      code: 'E_WRITE_FAILED',
      message: `render.path must be relative to the worktree; absolute paths are refused`,
    });
  }
  if (PATH_TRAVERSAL_SEGMENT_RE.test(renderPath)) {
    throw new EnigmaError({
      code: 'E_WRITE_FAILED',
      message: `render.path must not contain a parent-directory traversal segment`,
    });
  }
  const file = resolve(worktree, renderPath);
  const parentDir = dirname(file);
  if (!existsSync(parentDir)) {
    throw new EnigmaError({
      code: 'E_WRITE_FAILED',
      message: `render.path target parent directory does not exist; Enigma never creates directories in the user's worktree`,
    });
  }
  // Symlink escape: realpath of parent must be within realpath of worktree.
  let realWorktree: string;
  let realParent: string;
  try {
    realWorktree = realpathSync(worktree);
    realParent = realpathSync(parentDir);
  } catch (err) {
    throw new EnigmaError({
      code: 'E_WRITE_FAILED',
      message: `cannot resolve render.path: ${err instanceof Error ? err.constructor.name : String(err)}`,
    });
  }
  const rel = relative(realWorktree, realParent);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new EnigmaError({
      code: 'E_WRITE_FAILED',
      message: `render.path resolves outside the worktree via a symlinked parent directory`,
    });
  }
  return { file, exists: existsSync(file) };
}

/* ----------------------------- planning ---------------------------- */

/**
 * Build a render plan (NAMES-ONLY) without touching a depository or the
 * filesystem beyond the caller's already-loaded inputs. The function is
 * pure: deterministic for a given `(index, manifest, cwd, explicitName)`
 * tuple, and it returns every per-name decision the executor will later
 * carry out. Values never enter the plan.
 *
 * Tech Lead rule #2: no `value` field on the plan. The function does
 * not read, echo, or otherwise surface any secret material.
 */
export function buildRenderPlan(opts: {
  cwd: string;
  projectId: string;
  worktree: string;
  index: IndexFile;
  manifest: ProjectManifest;
  explicitName?: string;
}): RenderPlan {
  const { projectId, worktree, index, manifest, explicitName } = opts;
  const renderOverride = manifest.render;
  const enabled = renderOverride?.enabled !== false; // default true
  const renderPath = renderOverride?.path ?? DEFAULT_RENDER_PATH;
  const narrowing = renderOverride?.names !== undefined ? new Set(renderOverride.names) : undefined;

  // Existing block (raw lines) — used to decide keep-vs-rewrite.
  const existingContent = existsSync(join(worktree, renderPath)) ? readFileSync(join(worktree, renderPath), 'utf8') : '';
  const existingLines = readManagedBlockLines(existingContent, RENDER_BLOCK_MARKERS);
  const existingByName = new Map<string, string>();
  for (const line of existingLines) {
    const name = nameFromLine(line);
    if (name !== undefined) existingByName.set(name, line);
  }

  const fileResolution = resolveRenderTarget(worktree, renderPath);

  const warnings: string[] = [];

  if (!enabled) {
    return {
      enabled: false,
      worktree,
      file: fileResolution.file,
      fileIsNew: !fileResolution.exists,
      finalNames: [],
      toWrite: [],
      toKeep: [],
      toRemove: [...existingByName.keys()],
      perName: [],
      warnings,
      explicit: Boolean(explicitName),
    };
  }

  /* -- explicit `enigma render NAME` path -- */
  if (explicitName !== undefined) {
    // Look up the name in the index, scoped to project for this repo.
    const entry = index.entries.find(
      (e) => e.name === explicitName && e.scope === 'project' && e.projectId === projectId,
    );
    if (!entry) {
      throw new EnigmaError({
        code: 'E_NOT_FOUND',
        message: `${explicitName} is not a project-scoped secret for this repo`,
        secretName: explicitName,
      });
    }
    const toWrite: RenderToWrite[] = [{ name: entry.name, depository: entry.depository }];
    const toKeep: RenderToKeep[] = [];
    const finalNames = new Set<string>(existingByName.keys());
    finalNames.add(entry.name);
    for (const otherName of existingByName.keys()) {
      if (otherName === entry.name) continue;
      const line = existingByName.get(otherName)!;
      toKeep.push({ name: otherName, line });
    }
    return {
      enabled: true,
      worktree,
      file: fileResolution.file,
      fileIsNew: !fileResolution.exists,
      finalNames: [...finalNames].sort(),
      toWrite,
      toKeep,
      toRemove: [],
      perName: [{ kind: 'render', name: entry.name, depository: entry.depository }],
      warnings,
      explicit: true,
    };
  }

  /* -- plain `enigma render` (auto-set) path -- */
  const toWrite: RenderToWrite[] = [];
  const toKeep: RenderToKeep[] = [];
  const finalNames = new Set<string>();
  const perName: RenderNameStatus[] = [];
  const eligibleForAuto = new Set<string>();

  // Walk the index in declaration order. The render set is project-scoped
  // entries with a `none`-prompt depository, narrowed by `render.names`.
  for (const entry of index.entries) {
    if (entry.scope !== 'project') {
      if (entry.scope === 'global') perName.push({ kind: 'skipped-global', name: entry.name });
      continue;
    }
    if (entry.projectId !== projectId) continue;
    if (narrowing && !narrowing.has(entry.name)) {
      perName.push({ kind: 'skipped-manifest-narrowing', name: entry.name });
      continue;
    }
    const profile = promptProfileFor(entry.depository);
    if (profile === undefined) continue;
    if (profile !== 'none') {
      // Prompting-store project entry: never re-resolved on plain render.
      // If it was previously rendered (existing block), keep verbatim.
      if (existingByName.has(entry.name)) {
        const line = existingByName.get(entry.name)!;
        toKeep.push({ name: entry.name, line });
        finalNames.add(entry.name);
        perName.push({ kind: 'keep-prompting', name: entry.name, depository: entry.depository, line });
      } else {
        perName.push({ kind: 'skipped-prompting-auto', name: entry.name, depository: entry.depository });
      }
      continue;
    }
    eligibleForAuto.add(entry.name);
    toWrite.push({ name: entry.name, depository: entry.depository });
    finalNames.add(entry.name);
    perName.push({ kind: 'render', name: entry.name, depository: entry.depository });
  }

  // Drop names that were previously in the block but no longer match
  // any current criteria (entry removed, demoted to global, narrowed out,
  // or now in a prompting depository but not previously rendered). Tech
  // Lead rule #4: "Otherwise drop it."
  const toRemove: string[] = [];
  for (const prevName of existingByName.keys()) {
    if (finalNames.has(prevName)) continue;
    toRemove.push(prevName);
  }

  return {
    enabled: true,
    worktree,
    file: fileResolution.file,
    fileIsNew: !fileResolution.exists,
    finalNames: [...finalNames].sort(),
    toWrite,
    toKeep,
    toRemove,
    perName,
    warnings,
    explicit: false,
  };
}

/* ----------------------------- execution --------------------------- */

/** Per-name outcome from the executor — same shape as the perName status, but post-execution. */
export interface RenderOutcome {
  rendered: string[];
  kept: string[];
  removed: string[];
  failed: Array<{ name: string; errorCode: string; message: string }>;
  warnings: string[];
  /** True when `render.enabled: false` short-circuited the pass. */
  disabled: boolean;
  /** True when an atomic write failure occurred (the executor reports and exits non-zero). */
  writeError?: string;
}

export interface ExecuteRenderOptions {
  actor: AuditActor;
  projectId: string;
  worktree: string;
  /** Resolves a single name's value. Called once per `toWrite` entry, immediately before its line is built. */
  resolveValue: (name: string, depository: DepositoryId) => Promise<string>;
}

/**
 * Apply a render plan to disk under the per-target lock from Issue #106.
 * Resolves values one at a time (never batched — a per-name failure does
 * not abort the others, Tech Lead rule #5 / #8). Audits one `render`
 * line per name with `ok: true|false` and the static, value-free reason.
 *
 * Returns the structured outcome (used by the CLI to render
 * rendered/kept/skipped/failed sections). Never throws on per-name
 * failures; only lock / I/O / atomic-write / structural errors throw
 * (caller maps them to exit codes).
 */
export async function executeRender(plan: RenderPlan, opts: ExecuteRenderOptions): Promise<RenderOutcome> {
  const outcome: RenderOutcome = {
    rendered: [],
    kept: [],
    removed: [],
    failed: [],
    warnings: [...plan.warnings],
    disabled: false,
  };

  if (!plan.enabled) {
    outcome.disabled = true;
    return outcome;
  }

  // Acquire the per-target lock from Issue #106.
  const lock = acquireFileLock(renderLockPath(plan.file));
  try {
    const currentContent = existsSync(plan.file) ? readFileSync(plan.file, 'utf8') : '';
    // Resolve fresh values for `toWrite` entries. Failures are captured
    // per-name, others proceed (Tech Lead rule #5).
    const freshLines = new Map<string, string>();
    for (const item of plan.toWrite) {
      try {
        const value = await opts.resolveValue(item.name, item.depository);
        const encoded = encodeValue(value);
        freshLines.set(item.name, `${item.name}=${encoded}`);
        outcome.rendered.push(item.name);
      } catch (err) {
        const errorCode = err instanceof EnigmaError ? err.code : 'E_UNKNOWN';
        const message = err instanceof EnigmaError ? err.message : err instanceof Error ? err.constructor.name : 'UnknownError';
        // If the existing block already has a line for this name, keep
        // that line verbatim — it's bytes we already wrote, never
        // parsed here as a value (Tech Lead rule #5).
        const existing = readManagedBlockLines(currentContent, RENDER_BLOCK_MARKERS).find((l) => nameFromLine(l) === item.name);
        if (existing !== undefined) {
          outcome.kept.push(item.name);
          // We must surface this as a per-name failure too — but the
          // line in the block stays as-is. The plan's `perName` already
          // classified the name as 'render'; we update by tracking the
          // existing line in the body list. Use the kept-line path.
          freshLines.set(item.name, existing);
          // Record as a soft failure so the CLI can exit non-zero.
          outcome.failed.push({ name: item.name, errorCode, message });
          // Audit `ok: false` (the failure is real and must be logged).
          appendAuditEvent({
            op: 'render',
            name: item.name,
            depository: item.depository,
            actor: opts.actor,
            ok: false,
            error: auditErrorText(err),
            ...auditScopeFields({ scope: 'project', projectId: opts.projectId, projectPath: plan.worktree }),
          });
          continue;
        }
        outcome.failed.push({ name: item.name, errorCode, message });
        // Audit `ok: false` even though there's nothing to write —
        // the attempt happened and was refused (Tech Lead rule #5 / #8).
        appendAuditEvent({
          op: 'render',
          name: item.name,
          depository: item.depository,
          actor: opts.actor,
          ok: false,
          error: auditErrorText(err),
          ...auditScopeFields({ scope: 'project', projectId: opts.projectId, projectPath: plan.worktree }),
        });
        continue;
      }
      // Audit `ok: true` for the successful resolve.
      appendAuditEvent({
        op: 'render',
        name: item.name,
        depository: item.depository,
        actor: opts.actor,
        ok: true,
        error: null,
        ...auditScopeFields({ scope: 'project', projectId: opts.projectId, projectPath: plan.worktree }),
      });
    }

    // Build the new block body in name-sorted order. For each name in
    // `finalNames`, prefer a freshly-encoded line; otherwise fall back
    // to a kept line (byte-identical).
    const bodyLines: string[] = [];
    const usedNames = new Set<string>();
    for (const name of plan.finalNames) {
      const fresh = freshLines.get(name);
      const keepLine = plan.toKeep.find((k) => k.name === name)?.line;
      const line = fresh ?? keepLine;
      if (line !== undefined) {
        bodyLines.push(line);
        usedNames.add(name);
        if (fresh !== undefined && keepLine === undefined) {
          // newly rendered
        } else if (keepLine !== undefined && fresh === undefined) {
          outcome.kept.push(name);
        }
      }
    }
    // Names from toKeep that weren't in finalNames — already excluded
    // by `finalNames`, so nothing more to do.

    // Names previously rendered that aren't in finalNames anymore are
    // recorded as removed. (Tech Lead rule #4 / #7.)
    for (const prevName of plan.toRemove) outcome.removed.push(prevName);

    const nextContent = writeManagedBlock(currentContent, bodyLines, RENDER_BLOCK_MARKERS);

    // Atomic write — same protocol as `enigma import` (Issue #107 AC #2):
    // temp + rename in the target's directory at 0600.
    const writeResult = writeFileAtomic(plan.file, nextContent, FILE_MODE);
    if (!writeResult.ok) {
      const detail = writeResult.error ?? 'unknown failure';
      outcome.writeError = detail;
      // Surface as a warning rather than throwing — the caller maps to
      // an exit code. Keep names-only by avoiding the leftover path text.
      if (writeResult.leftoverPath) {
        outcome.warnings.push(
          `A temporary file containing the rewritten content was left behind at ${writeResult.leftoverPath} and could not be removed automatically — delete it manually as soon as possible.`,
        );
      }
      outcome.warnings.push(`Failed to rewrite ${plan.file} (${detail}).`);
      // Update the ledger anyway — the on-disk write failed but the
      // block body we intended to write is fully known; the ledger
      // records what the next render will retry.
    } else {
      // Make sure the file mode is 0600 even on a pre-existing file
      // whose mode may have drifted (AC #1: ".env" must be 0600).
      // writeFileAtomic's temp was 0600; the rename preserves it. This
      // branch only catches the case where the file pre-existed at a
      // looser mode and we want to tighten it now.
      try {
        const st = statSync(plan.file);
        if ((st.mode & 0o777) !== FILE_MODE) chmodSync(plan.file, FILE_MODE);
      } catch {
        // best-effort — the value sits in the file either way
      }
    }

    // Ledger update — `replaceTarget` is the only operation the renderer
    // may use (Tech Lead rule #1). Empty `finalNames` removes the
    // target; otherwise the names list is set exactly.
    if (plan.finalNames.length === 0) {
      replaceTarget({ projectId: opts.projectId, worktree: plan.worktree, file: plan.file, names: [] });
    } else {
      replaceTarget({ projectId: opts.projectId, worktree: plan.worktree, file: plan.file, names: plan.finalNames });
    }
  } finally {
    lock.release();
  }

  return outcome;
}

/* ----------------------------- names-only audit guard -------------- */
// This file imports only names (no values): the `resolveValue` callback
// owns value-bearing code. The leak-fence scans `src/mcp/**`, `src/web/**`,
// and `src/hooks/**` — none of those import this file. `resolveSecret` is
// the only sanctioned value-resolving call in the codebase and lives in
// `src/storage/manager.ts` (with its `enigma:leak-fence-allow` marker).
// The renderer module itself never calls resolveSecret — the wiring in
// `src/cli/commands/render.ts` injects a callback that does.