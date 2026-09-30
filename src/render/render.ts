/* ------------------------------------------------------------------ *
 *  Renderer (Issue #107)                                              *
 * ------------------------------------------------------------------ *
 *
 * Writes the worktree's managed render block into the configured target
 * file (default `.env`), preserving everything outside the block byte-
 * for-byte, under a per-target lock from Issue #106, with the result
 * reflected in the names-only render ledger (`src/render/ledger.ts`).
 *
 * Split between `buildRenderPlan` (pure and names-only: no file I/O, no
 * value or line content ever appears in it) and `executeRender` (the I/O
 * path). The executor runs, in this order:
 *
 *   1. resolve values that need resolving (no lock held, so an
 *      interactive prompt can never block another renderer),
 *   2. take the per-target lock (`renderLockPath(file)`),
 *   3. re-check the target is not a symlink, then read it ONCE,
 *   4. derive keep / remove / env-block-dedupe from THAT content,
 *   5. build the block, write atomically,
 *   6. only after the write result is known: update the ledger, audit,
 *   7. release the lock in `finally`.
 *
 * Rules:
 *
 *  - Target path: relative to the worktree, no `..`, parent must exist
 *    and resolve inside the worktree; a target that is itself a symlink
 *    is refused (never read through, never replaced). Validated in
 *    `buildRenderPlan`, i.e. before any read, and re-checked under the
 *    lock. All refusals are `E_WRITE_FAILED`.
 *  - AC #3: a name that appears in THIS target file's env-depository
 *    block (`# enigma:begin` / `# enigma:end`) is never written into the
 *    render block; it is reported by name as "already in the env block".
 *  - Plain render set: project-scope entries of this repo whose
 *    depository prompt profile is `none` (`encrypted`, `env`), narrowed
 *    by `render.names`. Global entries are out of scope. A project entry
 *    in a prompting store is rendered only explicitly
 *    (`enigma render NAME`); once its line is in the block, a plain
 *    render keeps that line as bytes and never re-resolves it.
 *  - Lines already in the block are copied as bytes from the file read
 *    under the lock; the plan never holds them.
 *  - Explicit `enigma render NAME` merges: only NAME's line is added or
 *    updated; every other line in the block stays byte-identical.
 *  - A failed resolve keeps the name's previous line when there is one
 *    (reported under Failed, "kept previous line"), else the name is
 *    simply absent. Other names still render.
 *  - Failure reasons are STATIC: an error's `message` is never copied
 *    into the outcome, stdout, stderr or the audit log.
 *  - Nothing to write and no existing block: the file is not touched. An
 *    existing block that would become empty is removed (markers
 *    included, outside bytes preserved).
 *  - Ledger names = exactly the names in the block that was written. On
 *    a failed write the ledger is unchanged and every attempted name is
 *    audited `ok: false`.
 *
 * Wiring outside `src/mcp/**` and `src/web/**` (ADR-001, leak-fence).
 * The `resolveValue` callback in production is `resolveSecret` from
 * `src/storage/manager.ts`, the sanctioned resolve path.
 */
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { appendAuditEvent, auditScopeFields } from '../core/audit.js';
import type { AuditActor } from '../core/audit.js';
import { acquireFileLock } from '../core/file-lock.js';
import { EnigmaError, type EnigmaErrorCode } from '../core/errors.js';
import { renderLockPath } from '../core/paths.js';
import { writeFileAtomic } from '../core/secure-file.js';
import type { IndexFile } from '../core/index-store.js';
import type { ProjectManifest } from '../core/config.js';
import type { DepositoryId, PromptProfile } from '../storage/interfaces.js';
import { DEPOSITORY_MODULES } from '../storage/detect.js';
import { replaceTarget } from './ledger.js';
import {
  RENDER_BEGIN_MARKER,
  RENDER_END_MARKER,
  ENV_BEGIN_MARKER,
  ENV_END_MARKER,
  detectEol,
  encodeValue,
  findBlock,
  readManagedBlockLines,
  writeManagedBlock,
} from '../storage/dotenv-file.js';
import type { BlockMarkers } from '../storage/dotenv-file.js';

const RENDER_BLOCK_MARKERS: BlockMarkers = { begin: RENDER_BEGIN_MARKER, end: RENDER_END_MARKER };
const ENV_BLOCK_MARKERS: BlockMarkers = { begin: ENV_BEGIN_MARKER, end: ENV_END_MARKER };
const FILE_MODE = 0o600;
const DEFAULT_RENDER_PATH = '.env';
const PATH_TRAVERSAL_SEGMENT_RE = /(^|[/\\])\.\.([/\\]|$)/;

/* ----------------------------- types ------------------------------- */

/** A project entry the renderer may act on: name and depository only. */
export interface RenderEntryRef {
  name: string;
  depository: DepositoryId;
}

/**
 * One render pass, NAMES ONLY. No value and no line content can be in
 * here, so even a serialised plan can never reach a secret's bytes. Which
 * previously-rendered lines are kept, dropped or skipped is decided in
 * `executeRender` from the file content read under the lock.
 */
export interface RenderPlan {
  enabled: boolean;
  worktree: string;
  /** Validated absolute target path. */
  file: string;
  explicit: boolean;
  warnings: string[];
  /** Names to resolve to a fresh value (auto-eligible entries, or the explicit NAME). */
  toResolve: RenderEntryRef[];
  /** Plain mode only: prompting-store project entries. Kept if the block already has their line, else skipped. */
  promptingStore: RenderEntryRef[];
  /** Plain mode only: project entries excluded by `.enigma.json` `render.names`. */
  narrowedOut: string[];
}

export interface RenderFailure {
  name: string;
  /** An `EnigmaErrorCode`, `E_UNKNOWN` for a non-Enigma error. */
  errorCode: string;
  /** Static text chosen by the renderer; never an error's message. */
  reason: string;
  keptPreviousLine: boolean;
}

export interface RenderSkip {
  name: string;
  reason: 'prompting-store' | 'narrowed-out';
}

export interface RenderOutcome {
  /** Names whose freshly resolved line is in the block that was written. */
  rendered: string[];
  /** Names whose existing line was copied as bytes without a resolve (prompting store, or an explicit render's other lines). */
  kept: string[];
  /** Names that were in the block and are not any more. */
  removed: string[];
  /** Per-name failures: a resolve error, or the write failing. */
  failed: RenderFailure[];
  /** Names that would have been rendered but are in this file's env-depository block. */
  alreadyInEnvBlock: string[];
  /** Names deliberately left out of the block, with why. */
  skipped: RenderSkip[];
  warnings: string[];
  /** True when `render.enabled: false` short-circuited the pass. */
  disabled: boolean;
  /** Set iff the atomic write failed: static text (plus the errno code when known). */
  writeError?: string;
  /** The resolved target file path. */
  file: string;
}

export interface ExecuteRenderOptions {
  actor: AuditActor;
  projectId: string;
  worktree: string;
  /** Resolves one name's value. Called BEFORE the lock is taken, so a prompt never holds it. */
  resolveValue: (name: string, depository: DepositoryId) => Promise<string>;
}

/* ----------------------------- helpers ----------------------------- */

const PROMPT_PROFILE_BY_DEPOSITORY = new Map<DepositoryId, PromptProfile>(
  DEPOSITORY_MODULES.map((m) => [m.id, m.promptProfile]),
);

/** Bare name of a `NAME=…` block line, or undefined when it is not an assignment. */
function nameFromLine(line: string): string | undefined {
  const eq = line.indexOf('=');
  return eq > 0 ? line.slice(0, eq) : undefined;
}

/** Map of name → raw line for every assignment in one managed block. */
function blockLinesByName(content: string, markers: BlockMarkers): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readManagedBlockLines(content, markers)) {
    const name = nameFromLine(line);
    if (name !== undefined) out.set(name, line);
  }
  return out;
}

function writeRefusal(message: string): EnigmaError {
  return new EnigmaError({ code: 'E_WRITE_FAILED', message });
}

/**
 * Validate the absolute target `file` against the worktree and return the
 * path to read and write: the parent's realpath plus the file name.
 *
 *  - the parent directory exists and its realpath is inside the worktree's
 *    realpath (so a parent swapped for a symlink out of the tree is refused);
 *  - the target is not a symlink (`lstat`, never `stat`: never read through
 *    it, never replace it);
 *  - the target is a regular file, or does not exist yet.
 *
 * Runs once up front (before any value is resolved) and again under the
 * lock, immediately before the read and write, because resolving a value
 * can take arbitrarily long. Messages name the problem only.
 */
function validateTargetFile(worktree: string, file: string): string {
  const parentDir = dirname(file);
  if (!existsSync(parentDir)) {
    throw writeRefusal("render.path target parent directory does not exist; Enigma never creates directories in the user's worktree");
  }
  let realWorktree: string;
  let realParent: string;
  try {
    realWorktree = realpathSync(worktree);
    realParent = realpathSync(parentDir);
  } catch (err) {
    throw writeRefusal(`cannot resolve render.path: ${(err as NodeJS.ErrnoException).code ?? 'unknown error'}`);
  }
  const rel = relative(realWorktree, realParent);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw writeRefusal('render.path resolves outside the worktree via a symlinked parent directory');
  }
  const target = join(realParent, basename(file));
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw writeRefusal(`cannot inspect render.path target: ${(err as NodeJS.ErrnoException).code ?? 'unknown error'}`);
  }
  if (stat.isSymbolicLink()) throw writeRefusal('render.path target is a symlink; refusing to read through or replace it');
  if (!stat.isFile()) throw writeRefusal('render.path target is not a regular file');
  return target;
}

/**
 * Validate `renderPath` against the worktree and return the absolute
 * target. Runs before anything is read or resolved.
 */
function resolveRenderTarget(worktree: string, renderPath: string): string {
  if (isAbsolute(renderPath)) {
    throw writeRefusal('render.path must be relative to the worktree; absolute paths are refused');
  }
  if (PATH_TRAVERSAL_SEGMENT_RE.test(renderPath)) {
    throw writeRefusal('render.path must not contain a parent-directory traversal segment');
  }
  if (renderPath.trim() === '' || normalize(renderPath) === '.' || /[/\\]$/.test(renderPath)) {
    throw writeRefusal('render.path must name a file, not be empty, "." or a directory path ending in a separator');
  }
  const file = resolve(worktree, renderPath);
  validateTargetFile(worktree, file);
  return file;
}

/* ----------------------------- planning ---------------------------- */

/**
 * Build a render plan (NAMES ONLY) from the index and manifest. When
 * rendering is on, validates `render.path` first; performs no read of the
 * target file.
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
  const enabled = renderOverride?.enabled !== false;
  const renderPath = renderOverride?.path ?? DEFAULT_RENDER_PATH;
  // Path validation runs only when rendering is on: a disabled render must
  // still say "rendering is off" whatever `render.path` holds.
  const file = enabled ? resolveRenderTarget(worktree, renderPath) : resolve(worktree, renderPath);

  const plan: RenderPlan = {
    enabled,
    worktree,
    file,
    explicit: explicitName !== undefined,
    warnings: [],
    toResolve: [],
    promptingStore: [],
    narrowedOut: [],
  };
  if (!enabled) return plan;

  const projectEntries = index.entries.filter((e) => e.scope === 'project' && e.projectId === projectId);

  if (explicitName !== undefined) {
    const entry = projectEntries.find((e) => e.name === explicitName);
    if (!entry) {
      throw new EnigmaError({
        code: 'E_NOT_FOUND',
        message: `${explicitName} is not a project-scoped secret for this repo`,
        secretName: explicitName,
      });
    }
    plan.toResolve.push({ name: entry.name, depository: entry.depository });
    return plan;
  }

  const narrowing = renderOverride?.names !== undefined ? new Set(renderOverride.names) : undefined;
  for (const entry of projectEntries) {
    if (narrowing && !narrowing.has(entry.name)) {
      plan.narrowedOut.push(entry.name);
      continue;
    }
    const profile = PROMPT_PROFILE_BY_DEPOSITORY.get(entry.depository);
    if (profile === undefined) continue;
    const ref = { name: entry.name, depository: entry.depository };
    if (profile === 'none') plan.toResolve.push(ref);
    else plan.promptingStore.push(ref);
  }
  return plan;
}

/* ----------------------------- static reasons ----------------------- */

/**
 * Never copy an error's `message`: each known code maps to a fixed
 * string; an unknown code gets a generic reason that names the code.
 */
const STATIC_REASONS: Partial<Record<EnigmaErrorCode, string>> = {
  E_NOT_FOUND: 'failed to resolve: not found',
  E_DEPOSITORY_UNAVAILABLE: 'failed to resolve: depository unavailable',
  E_READ_FAILED: 'failed to resolve: read failed',
  E_VALUE_TOO_LARGE: 'failed to resolve: value too large for this depository',
  E_REF_INVALID: 'failed to resolve: ref invalid',
  E_VAULT_MISSING: 'failed to resolve: vault missing',
  E_VAULT_CORRUPT: 'failed to resolve: vault corrupt',
  E_WRITE_FAILED: 'failed to rewrite the target file',
};
const UNKNOWN_ERROR_CODE = 'E_UNKNOWN';
const TARGET_CHANGED_CODE = 'E_TARGET_CHANGED';

function staticReasonFor(code: string): string {
  if (code === UNKNOWN_ERROR_CODE) return 'failed to resolve: unknown error';
  if (code === TARGET_CHANGED_CODE) return 'not resolved: the target file changed while rendering; run enigma render again';
  return STATIC_REASONS[code as EnigmaErrorCode] ?? `failed to resolve (${code})`;
}

/** Static text for a failed atomic write: the errno code when the message carries one, never the message. */
function staticWriteError(message: string | undefined): string {
  const code = message?.match(/^(E[A-Z0-9]+):/)?.[1];
  return code ? `failed to rewrite the target file (${code})` : 'failed to rewrite the target file';
}

/* ----------------------------- execution --------------------------- */

/**
 * Drop the render block (markers included), leaving every other byte in
 * place. `writeManagedBlock` gives an appended block the file's own EOF
 * state, so removing its lines restores the original bytes exactly.
 */
function stripRenderBlock(content: string): string {
  const eol = detectEol(content);
  const lines = content.split(eol);
  const block = findBlock(lines, RENDER_BLOCK_MARKERS);
  if (!block) return content;
  return [...lines.slice(0, block.beginIdx), ...lines.slice(block.endIdx + 1)].join(eol);
}

type ResolveResult = { ok: true; value: string } | { ok: false; code: string };

/**
 * Refuse a render block that has a begin marker but no end marker after it
 * (a damaged file, e.g. text glued onto the end marker). Writing on top of
 * it would append a second block, so nothing is resolved or written.
 */
function assertRenderBlockIntact(content: string, file: string): void {
  const lines = content.split(detectEol(content));
  if (lines.includes(RENDER_BEGIN_MARKER) && findBlock(lines, RENDER_BLOCK_MARKERS) === undefined) {
    throw writeRefusal(
      `${file}: the render block is damaged: "${RENDER_BEGIN_MARKER}" has no matching "${RENDER_END_MARKER}" line. Fix the file by hand, then run enigma render again.`,
    );
  }
}

/**
 * Apply a render plan to disk. See the header for the order of work.
 * Throws only for structural refusals (target became a symlink, lock
 * failure, unreadable target); per-name and write failures are outcomes.
 */
export async function executeRender(plan: RenderPlan, opts: ExecuteRenderOptions): Promise<RenderOutcome> {
  const outcome: RenderOutcome = {
    rendered: [],
    kept: [],
    removed: [],
    failed: [],
    alreadyInEnvBlock: [],
    skipped: [],
    warnings: [...plan.warnings],
    disabled: false,
    file: plan.file,
  };
  if (!plan.enabled) {
    outcome.disabled = true;
    return outcome;
  }

  // 0. An unlocked, advisory read of the target (path already validated):
  //    refuse a damaged render block before anything is resolved, and skip
  //    names already in this file's env block so they never trigger a store
  //    prompt. The real keep/dedupe decisions are re-made on the locked read.
  const peekPath = validateTargetFile(plan.worktree, plan.file);
  const peek = existsSync(peekPath) ? readFileSync(peekPath, 'utf8') : '';
  assertRenderBlockIntact(peek, plan.file);
  const peekEnvNames = new Set(blockLinesByName(peek, ENV_BLOCK_MARKERS).keys());

  // 1. Resolve BEFORE the lock. Values live only in this local map: they
  //    are encoded into a block line below and never returned or stored.
  const resolved = new Map<string, ResolveResult>();
  for (const item of plan.toResolve) {
    if (peekEnvNames.has(item.name)) continue;
    try {
      resolved.set(item.name, { ok: true, value: await opts.resolveValue(item.name, item.depository) });
    } catch (err) {
      resolved.set(item.name, { ok: false, code: err instanceof EnigmaError ? err.code : UNKNOWN_ERROR_CODE });
    }
  }
  const depositoryOf = new Map(plan.toResolve.map((t) => [t.name, t.depository] as const));

  // 2. Lock.
  const lock = acquireFileLock(renderLockPath(plan.file));
  try {
    // 3. Re-run the full target validation now that the lock is held and
    //    before touching the file: resolving a value may have taken long
    //    enough for the parent or the target to be swapped. The path it
    //    returns is the one read and written below. A refusal writes
    //    nothing, changes no ledger row, and audits every attempted name.
    let target: string;
    let current: string;
    try {
      target = validateTargetFile(plan.worktree, plan.file);
      current = existsSync(target) ? readFileSync(target, 'utf8') : '';
      assertRenderBlockIntact(current, plan.file);
    } catch (err) {
      for (const item of plan.toResolve) {
        appendAuditEvent({
          op: 'render',
          name: item.name,
          depository: item.depository,
          actor: opts.actor,
          ok: false,
          error: staticReasonFor('E_WRITE_FAILED'),
          ...auditScopeFields({ scope: 'project', projectId: opts.projectId, projectPath: plan.worktree }),
        });
      }
      throw err;
    }
    // The canonical path that is actually written: what the ledger and the
    // report name.
    outcome.file = target;

    // 4. Everything file-derived comes from `current`.
    const envBlockNames = new Set(blockLinesByName(current, ENV_BLOCK_MARKERS).keys());
    const existing = blockLinesByName(current, RENDER_BLOCK_MARKERS);
    const hasExistingBlock = findBlock(current.split(detectEol(current)), RENDER_BLOCK_MARKERS) !== undefined;

    /** name → raw block line, for the block about to be written. */
    const finalLines = new Map<string, string>();
    /** Names with a fresh value in `finalLines`. */
    const freshNames = new Set<string>();
    /** Names whose resolve failed (audit + Failed section). */
    const resolveFailures: Array<{ name: string; code: string }> = [];

    if (plan.explicit) {
      // Merge: every existing line stays as bytes; only NAME changes.
      for (const [name, line] of existing) finalLines.set(name, line);
    } else {
      for (const ref of plan.promptingStore) {
        const line = existing.get(ref.name);
        if (line !== undefined) finalLines.set(ref.name, line);
        else outcome.skipped.push({ name: ref.name, reason: 'prompting-store' });
      }
    }
    for (const item of plan.toResolve) {
      if (envBlockNames.has(item.name)) continue; // AC #3, handled below
      // Skipped before the lock as an env-block name, but not one on the locked read: the file changed in between.
      const result = resolved.get(item.name) ?? { ok: false as const, code: TARGET_CHANGED_CODE };
      if (result.ok) {
        finalLines.set(item.name, `${item.name}=${encodeValue(result.value)}`);
        freshNames.add(item.name);
      } else {
        resolveFailures.push({ name: item.name, code: result.code });
        // Previous line, if any, survives: in explicit mode it is already
        // in `finalLines`; in plain mode copy it from `existing`.
        const previous = existing.get(item.name);
        if (previous !== undefined) finalLines.set(item.name, previous);
      }
    }
    // AC #3: nothing that is in this file's env block is ever in the render block.
    for (const name of envBlockNames) {
      if (finalLines.delete(name) || plan.toResolve.some((t) => t.name === name)) {
        outcome.alreadyInEnvBlock.push(name);
      }
    }
    for (const name of plan.narrowedOut) {
      if (!existing.has(name)) outcome.skipped.push({ name, reason: 'narrowed-out' });
    }

    // 5. Build the next content.
    // Existing lines keep their file order and bytes (an updated name keeps
    // its position); new names are appended in sorted order.
    const bodyNames = [
      ...[...existing.keys()].filter((n) => finalLines.has(n)),
      ...[...finalLines.keys()].filter((n) => !existing.has(n)).sort((a, b) => a.localeCompare(b)),
    ];
    let next: string | undefined;
    if (bodyNames.length > 0) next = writeManagedBlock(current, bodyNames.map((n) => finalLines.get(n)!), RENDER_BLOCK_MARKERS);
    else if (hasExistingBlock) next = stripRenderBlock(current);
    // else: nothing to write and nothing to strip: the file is not touched.

    let writeOk = true;
    if (next !== undefined) {
      const result = writeFileAtomic(target, next, FILE_MODE);
      writeOk = result.ok;
      if (!result.ok) {
        outcome.writeError = staticWriteError(result.error);
        // The leftover temp file holds secret content: surface it only if cleanup itself failed.
        if (result.leftoverPath) {
          outcome.warnings.push(
            `A temporary file with the rewritten content could not be removed automatically: delete ${result.leftoverPath} yourself as soon as possible.`,
          );
        }
      } else {
        try {
          if ((statSync(target).mode & 0o777) !== FILE_MODE) chmodSync(target, FILE_MODE);
        } catch {
          // best-effort tighten
        }
      }
    }

    // 6. Ledger and audit, only now that the write result is known.
    const scope = auditScopeFields({ scope: 'project', projectId: opts.projectId, projectPath: plan.worktree });
    const audit = (name: string, ok: boolean, error: string | null): void =>
      appendAuditEvent({ op: 'render', name, depository: depositoryOf.get(name)!, actor: opts.actor, ok, error, ...scope });

    if (!writeOk) {
      // Ledger untouched; the file is as it was, so nothing was rendered or removed.
      const resolveCodes = new Map(resolveFailures.map((f) => [f.name, f.code] as const));
      for (const item of plan.toResolve) {
        if (envBlockNames.has(item.name)) continue;
        const code = resolveCodes.get(item.name) ?? 'E_WRITE_FAILED';
        const reason = staticReasonFor(code);
        audit(item.name, false, reason);
        // The file is unchanged, so an old line for this name is still in it.
        outcome.failed.push({ name: item.name, errorCode: code, reason, keptPreviousLine: existing.has(item.name) });
      }
      return outcome;
    }

    replaceTarget({ projectId: opts.projectId, worktree: plan.worktree, file: target, names: bodyNames });

    for (const name of freshNames) {
      audit(name, true, null);
      outcome.rendered.push(name);
    }
    for (const f of resolveFailures) {
      const reason = staticReasonFor(f.code);
      audit(f.name, false, reason);
      outcome.failed.push({ name: f.name, errorCode: f.code, reason, keptPreviousLine: finalLines.has(f.name) });
    }
    const failedNames = new Set(resolveFailures.map((f) => f.name));
    for (const name of bodyNames) {
      if (existing.has(name) && !freshNames.has(name) && !failedNames.has(name)) outcome.kept.push(name);
    }
    for (const name of existing.keys()) {
      if (!finalLines.has(name)) outcome.removed.push(name);
    }
    outcome.rendered.sort();
    outcome.kept.sort();
    outcome.removed.sort();
    outcome.alreadyInEnvBlock.sort();
    return outcome;
  } finally {
    // 7. Release.
    lock.release();
  }
}
