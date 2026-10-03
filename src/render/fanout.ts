/* ------------------------------------------------------------------ *
 *  Render lifecycle fan-out (Issue #108)                              *
 * ------------------------------------------------------------------ *
 *
 * Keeps every rendered copy of one secret current after `setSecret`,
 * `deleteSecret` and `move` commit to the index. Runs AFTER the index commit
 * and outside the index lock (ADR-003), one target at a time, each under that
 * target's own per-file lock (`renderLockPath`, Issue #106).
 *
 * Three operations, all on ONE name:
 *
 *  - `set`    — write `NAME=<value>` into the target's render block.
 *  - `strip`  — remove NAME's line (the secret was deleted, or moved to a
 *               prompting store, which is never auto-rendered).
 *  - `dedupe` — remove NAME's line only if THIS file's env-depository block now
 *               holds NAME (a `move --to env` wrote it there; AC #3 of #107:
 *               a name is never in both blocks).
 *
 * Value in hand only. `set` receives the value as an argument and encodes it
 * into one line; nothing here resolves a value, prompts a store, or reads
 * another name. Every other line of the file keeps its bytes and terminator;
 * an in-block comment is kept too (the renderer rewrites it on a full render,
 * the fan-out does not).
 *
 * "Last committed rotate wins": two rotates commit in index order but their
 * fan-outs can run in either order. Each `set` therefore carries the identity
 * of ITS index commit (`updatedAt`, `ref`, `depository` — `setSecret` makes
 * `updatedAt` strictly increase per entry), and under the target's lock,
 * immediately before writing, re-reads the index (lock-free; atomic rename)
 * and writes only if the entry is still that commit. A stale fan-out skips;
 * the newer commit's own fan-out writes its value. Check and write share one
 * lock hold, so no write can slip between them. `strip` is the mirror: it
 * skips when a render-eligible entry for NAME exists again (the re-created
 * secret owns the line).
 *
 * Per-target outcomes (the originating operation always succeeds):
 *  - silent skip: `render.enabled:false`; `render.names` excludes NAME (`set`);
 *    superseded; nothing would change.
 *  - skip + names/paths-only warning + `ok:false` audit line, ledger row KEPT
 *    (doctor prunes, #110): worktree gone, unwritable, damaged render block,
 *    refused target (symlink, escaping or swapped parent), `render.path`
 *    changed since the ledger row, unusable `.enigma.json`, lock failure.
 *
 * The ledger row is rewritten with `replaceTarget` to exactly the names in the
 * block after the write (never the global `removeNames`: it would strip NAME
 * from OTHER projects' rows).
 *
 * Reasons in warnings and audit lines come from a fixed table or
 * `classifyCleanupError`; an error's message is never copied.
 */
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { appendAuditEvent, auditScopeFields, classifyCleanupError } from '../core/audit.js';
import type { AuditActor } from '../core/audit.js';
import { loadProjectManifest } from '../core/config.js';
import type { ProjectManifest } from '../core/config.js';
import { EnigmaError } from '../core/errors.js';
import { acquireFileLock } from '../core/file-lock.js';
import { findIndexEntry, readIndex } from '../core/index-store.js';
import { renderLockPath } from '../core/paths.js';
import { writeFileAtomic } from '../core/secure-file.js';
import { DEPOSITORY_MODULES } from '../storage/detect.js';
import { checkEnvGitignore } from '../storage/depositories/env.js';
import {
  dominantEol,
  encodeValue,
  joinPhysicalLines,
  splitPhysicalLines,
  writeRenderBlock,
} from '../storage/dotenv-file.js';
import type { PhysicalLine } from '../storage/dotenv-file.js';
import type { DepositoryId } from '../storage/interfaces.js';
import { replaceTarget, targetsFor } from './ledger.js';
import {
  DEFAULT_RENDER_PATH,
  FILE_MODE,
  envBlockNamesOf,
  nameFromLine,
  readRenderBlock,
  resolveRenderTarget,
  stripRenderBlock,
  validateTargetFile,
} from './render.js';

/* ----------------------------- types ------------------------------- */

/** Identity of one index commit: what a stale `set` is compared against. */
export interface CommitIdentity {
  updatedAt: string;
  ref: string;
  depository: DepositoryId;
}

export interface FanOutSetInput {
  name: string;
  /** The value already in hand. Encoded into one block line; never stored, returned, logged or audited. */
  value: string;
  projectId: string;
  /** Lexical worktree the originating call ran in (`findProjectPath(cwd)`): the one target a NEW secret is added to. */
  worktree: string;
  /** True for a brand-new secret in a no-prompt store: `worktree` gains the name even if it was not a ledger target. */
  addWorktree: boolean;
  commit: CommitIdentity;
  actor: AuditActor;
}

export interface FanOutRemoveInput {
  name: string;
  projectId: string;
  /** Depository of the entry that was removed or moved (audit only). */
  depository: DepositoryId;
  actor: AuditActor;
  /** `strip`: delete / move to a prompting store. `dedupe`: move to env (drop only where the env block now holds NAME). */
  mode: 'strip' | 'dedupe';
}

type Operation =
  | { kind: 'set'; value: string; commit: CommitIdentity }
  | { kind: 'strip' }
  | { kind: 'dedupe' };

interface TargetInput {
  name: string;
  projectId: string;
  worktree: string;
  /** Canonical `file` of the ledger row, when the target came from the ledger. */
  ledgerFile?: string;
  depository: DepositoryId;
  actor: AuditActor;
  op: Operation;
}

/** One target to update: a ledger row (`ledgerFile` set) or a worktree being added (`isNew`). */
interface TargetSpec {
  worktree: string;
  ledgerFile?: string;
  isNew?: boolean;
}

type TargetResult =
  | { status: 'written'; renderPath: string }
  | { status: 'silent' }
  | { status: 'warn'; reason: string; extraWarning?: string };

/* ----------------------------- test seam --------------------------- */

let gate: (() => Promise<void> | void) | undefined;

/** Test-only (like `__setLockTimingForTesting`): runs after the index commit and before any fan-out, so a real-process test can order two fan-outs deterministically. */
export function __setFanoutGateForTesting(fn: (() => Promise<void> | void) | undefined): void {
  gate = fn;
}

/* ----------------------------- helpers ----------------------------- */

const PROMPT_PROFILE = new Map<DepositoryId, string>(DEPOSITORY_MODULES.map((m) => [m.id, m.promptProfile]));

/** True when `depository` never prompts (`encrypted`, `env`): its entries are auto-rendered. */
export function isAutoRenderable(depository: DepositoryId): boolean {
  return PROMPT_PROFILE.get(depository) === 'none';
}

/** Internal control flow for a per-target skip with a fixed reason. */
class Skip extends Error {
  constructor(
    readonly reason: string,
    readonly extraWarning?: string,
  ) {
    super(reason);
  }
}

/** Fixed reason for an error thrown while preparing or touching a target. Never the error's message. */
function reasonFor(err: unknown): string {
  if (err instanceof Skip) return err.reason;
  if (err instanceof EnigmaError) {
    if (err.code === 'E_LOCK_TIMEOUT' || err.code === 'E_LOCK_UNAVAILABLE') return 'lock-timeout';
    if (err.code === 'E_CONFIG_CORRUPT') return 'config-invalid';
    if (err.code === 'E_WRITE_FAILED') return 'target-refused';
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'not-writable';
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'worktree-missing';
  return classifyCleanupError(err);
}

function warningFor(worktree: string, name: string, reason: string): string {
  return `render target ${worktree} was not updated for ${name} (${reason})`;
}

/** The index entry for `name` in this project is auto-renderable right now. */
function eligibleEntryExists(name: string, projectId: string): boolean {
  const entry = findIndexEntry(readIndex(), name, 'project', projectId);
  return entry !== undefined && isAutoRenderable(entry.depository);
}

function isCurrentCommit(name: string, projectId: string, commit: CommitIdentity): boolean {
  const entry = findIndexEntry(readIndex(), name, 'project', projectId);
  return entry !== undefined && entry.updatedAt === commit.updatedAt && entry.ref === commit.ref && entry.depository === commit.depository;
}

/** Terminate an unterminated last line (the end marker at EOF) in the file's dominant EOL, as `writeRenderBlock` does. */
function terminated(line: PhysicalLine, eol: '\r\n' | '\n'): PhysicalLine {
  return line.term === '' ? { raw: line.raw + (eol === '\r\n' ? '\r' : ''), term: '\n', text: line.text } : line;
}

/** Indices of block body lines assigning `name`, between the markers. */
function bodyIndicesFor(lines: readonly PhysicalLine[], block: { beginIdx: number; endIdx: number }, name: string): number[] {
  const out: number[] = [];
  for (let i = block.beginIdx + 1; i < block.endIdx; i++) {
    if (nameFromLine(lines[i]!.text) === name) out.push(i);
  }
  return out;
}

function blockAssignmentNames(lines: readonly PhysicalLine[], block: { beginIdx: number; endIdx: number }): string[] {
  const names: string[] = [];
  for (let i = block.beginIdx + 1; i < block.endIdx; i++) {
    const n = nameFromLine(lines[i]!.text);
    if (n !== undefined) names.push(n);
  }
  return names;
}

/** `set`: replace NAME's line in place (dropping repeats of it) or append it at the end of the block; a new block when there is none. */
function applySet(current: string, name: string, value: string): { next: string; names: string[] } {
  const lines = splitPhysicalLines(current);
  const eol = dominantEol(lines);
  const text = `${name}=${encodeValue(value)}`;
  const { scan } = readRenderBlock(current, '');
  if (!scan.block) {
    return { next: writeRenderBlock(current, [text]), names: [name] };
  }
  const block = scan.block;
  const fresh: PhysicalLine = { raw: text + (eol === '\r\n' ? '\r' : ''), term: '\n', text };
  const existing = bodyIndicesFor(lines, block, name);
  const out: PhysicalLine[] = [];
  lines.forEach((line, i) => {
    if (i === block.endIdx) {
      if (existing.length === 0) out.push(fresh);
      out.push(terminated(line, eol));
    } else if (existing.length > 0 && i === existing[0]) {
      out.push(fresh);
    } else if (existing.includes(i)) {
      // a repeat of NAME's line: dropped, so one definition remains
    } else {
      out.push(line);
    }
  });
  const next = joinPhysicalLines(out);
  const after = splitPhysicalLines(next);
  const rescanned = readRenderBlock(next, '').scan.block!;
  return { next, names: blockAssignmentNames(after, rescanned) };
}

/**
 * `strip`: remove NAME's line(s); a block left with no assignment is removed
 * whole. When NAME is not in the block, `next` is the content unchanged and
 * `names` is what the block holds (so the caller can still sync the ledger).
 */
function applyStrip(current: string, name: string): { next: string; names: string[] } {
  const lines = splitPhysicalLines(current);
  const { scan } = readRenderBlock(current, '');
  if (!scan.block) return { next: current, names: [] };
  const block = scan.block;
  const existing = bodyIndicesFor(lines, block, name);
  if (existing.length === 0) return { next: current, names: blockAssignmentNames(lines, block) };
  const eol = dominantEol(lines);
  const remaining = lines.filter((_, i) => !existing.includes(i));
  const shifted = { beginIdx: block.beginIdx, endIdx: block.endIdx - existing.length };
  if (blockAssignmentNames(remaining, shifted).length === 0) {
    return { next: stripRenderBlock(current, block), names: [] };
  }
  remaining[shifted.endIdx] = terminated(remaining[shifted.endIdx]!, eol);
  return { next: joinPhysicalLines(remaining), names: blockAssignmentNames(remaining, shifted) };
}

/* ----------------------------- one target -------------------------- */

function loadManifest(worktree: string): ProjectManifest {
  const manifest = loadProjectManifest(worktree);
  if (manifest.renderError !== undefined) throw new Skip('config-invalid');
  return manifest;
}

function updateTarget(input: TargetInput): TargetResult {
  const { name, projectId, worktree, op } = input;
  // `render` for a line written, `unrender` for one removed. A `set` that finds NAME in the env
  // block removes instead, so this is settled once the file has been read.
  let removes = op.kind !== 'set';
  const audit = (ok: boolean, error: string | null): void =>
    appendAuditEvent({
      op: removes ? 'unrender' : 'render',
      name,
      depository: input.depository,
      actor: input.actor,
      ok,
      error,
      ...auditScopeFields({ scope: 'project', projectId, projectPath: worktree }),
    });

  try {
    if (!existsSync(worktree)) throw new Skip('worktree-missing');
    const manifest = loadManifest(worktree);
    if (manifest.render?.enabled === false) return { status: 'silent' };
    if (op.kind === 'set' && manifest.render?.names !== undefined && !manifest.render.names.includes(name)) return { status: 'silent' };

    const renderPath = manifest.render?.path ?? DEFAULT_RENDER_PATH;
    const lexicalFile = resolveRenderTarget(worktree, renderPath);
    const peekPath = validateTargetFile(worktree, lexicalFile);
    if (input.ledgerFile !== undefined && input.ledgerFile !== peekPath) throw new Skip('render-path-changed');

    const lock = acquireFileLock(renderLockPath(peekPath));
    try {
      // The lock is held: validate again, before reading or writing (the parent or target may have been swapped).
      const target = validateTargetFile(worktree, lexicalFile);
      if (target !== peekPath) throw new Skip('target-refused');

      // Guard, in the same lock hold as the write (see the header).
      if (op.kind === 'set' && !isCurrentCommit(name, projectId, op.commit)) return { status: 'silent' };
      if (op.kind === 'strip' && eligibleEntryExists(name, projectId)) return { status: 'silent' };

      const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
      try {
        readRenderBlock(current, lexicalFile);
      } catch {
        throw new Skip('damaged-render-block');
      }

      // A name in this file's env block is never in the render block (#107 AC #3): a `set` for it
      // becomes a drop of any stale render line, and `dedupe` only ever acts on such a name.
      const inEnvBlock = envBlockNamesOf(current).has(name);
      if (op.kind === 'dedupe' && !inEnvBlock) return { status: 'silent' };
      removes = op.kind !== 'set' || inEnvBlock;
      const result = removes ? applyStrip(current, name) : applySet(current, name, (op as { value: string }).value);

      const ledgerRow = targetsFor({ projectId }).find((t) => t.worktree === worktree && t.file === target);
      if (result.next === current) {
        // Nothing to write. Keep the ledger honest for a target whose file already says so.
        syncLedger(projectId, worktree, target, result.names, ledgerRow?.names);
        return { status: 'silent' };
      }

      const written = writeFileAtomic(target, result.next, FILE_MODE);
      if (!written.ok) {
        // The leftover temp file holds secret content: surface it only if cleanup itself failed.
        throw new Skip(
          'not-writable',
          written.leftoverPath
            ? `A temporary file with the rewritten content could not be removed automatically: delete ${written.leftoverPath} yourself as soon as possible.`
            : undefined,
        );
      }
      try {
        if ((statSync(target).mode & 0o777) !== FILE_MODE) chmodSync(target, FILE_MODE);
      } catch {
        // best-effort tighten, as the renderer does
      }
      replaceTarget({ projectId, worktree, file: target, names: result.names });
      audit(true, null);
      return { status: 'written', renderPath };
    } finally {
      lock.release();
    }
  } catch (err) {
    const reason = reasonFor(err);
    try {
      audit(false, reason);
    } catch {
      // an audit failure must not turn a skipped target into a failed operation
    }
    return { status: 'warn', reason, extraWarning: err instanceof Skip ? err.extraWarning : undefined };
  }
}

/** Rewrite the ledger row only when it disagrees with the file's block (an unchanged write must not churn `renderedAt`). */
function syncLedger(projectId: string, worktree: string, file: string, names: string[], rowNames: string[] | undefined): void {
  const want = [...names].sort();
  const have = rowNames === undefined ? [] : [...rowNames].sort();
  if (want.length === have.length && want.every((n, i) => n === have[i])) return;
  replaceTarget({ projectId, worktree, file, names });
}

/* ----------------------------- drivers ----------------------------- */

/** Apply `op` to each target; collect warnings. Never throws. */
function runTargets(targets: TargetSpec[], base: Omit<TargetInput, 'worktree' | 'ledgerFile'>): string[] {
  const warnings: string[] = [];
  for (const t of targets) {
    const result = updateTarget({ ...base, worktree: t.worktree, ledgerFile: t.ledgerFile });
    if (result.status === 'warn') {
      warnings.push(warningFor(t.worktree, base.name, result.reason));
      if (result.extraWarning) warnings.push(result.extraWarning);
    } else if (result.status === 'written' && t.isNew) {
      // A render target the user may not have thought about: same gitignore hint `enigma render` gives.
      for (const w of checkEnvGitignore(t.worktree, result.renderPath)) if (!warnings.includes(w)) warnings.push(w);
    }
  }
  return warnings;
}

/**
 * `set` fan-out: every ledger target of this project that holds NAME, plus
 * (for a brand-new secret in a no-prompt store) the originating worktree.
 * Returns names/paths-only warnings.
 */
export async function fanOutSet(input: FanOutSetInput): Promise<string[]> {
  try {
    if (gate) await gate();
    const holders = targetsFor({ projectId: input.projectId, name: input.name });
    const targets: TargetSpec[] = holders.map((h) => ({ worktree: h.worktree, ledgerFile: h.file }));
    if (input.addWorktree && !holders.some((h) => h.worktree === input.worktree)) targets.push({ worktree: input.worktree, isNew: true });
    return runTargets(targets, {
      name: input.name,
      projectId: input.projectId,
      depository: input.commit.depository,
      actor: input.actor,
      op: { kind: 'set', value: input.value, commit: input.commit },
    });
  } catch (err) {
    return [`render fan-out skipped for ${input.name} (${reasonFor(err)})`];
  }
}

/** `strip` / `dedupe` fan-out over every ledger target of this project that holds NAME. */
export async function fanOutRemove(input: FanOutRemoveInput): Promise<string[]> {
  try {
    if (gate) await gate();
    const holders = targetsFor({ projectId: input.projectId, name: input.name });
    return runTargets(
      holders.map((h) => ({ worktree: h.worktree, ledgerFile: h.file })),
      { name: input.name, projectId: input.projectId, depository: input.depository, actor: input.actor, op: { kind: input.mode } },
    );
  } catch (err) {
    return [`render fan-out skipped for ${input.name} (${reasonFor(err)})`];
  }
}

