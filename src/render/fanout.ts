/* ------------------------------------------------------------------ *
 *  Render lifecycle fan-out (Issue #108)                              *
 * ------------------------------------------------------------------ *
 *
 * Keeps every rendered copy of one secret current after `setSecret`,
 * `deleteSecret` and `move` commit to the index. Runs AFTER the index commit
 * and outside the index lock (ADR-003), one target at a time, each under that
 * target's own per-file lock (`renderLockPath`, Issue #106).
 *
 * Two operations, both on ONE name:
 *
 *  - `set`   — write `NAME=<value>` into the target's render block. If THIS
 *              file's env-depository block holds NAME, the render line is
 *              dropped instead (#107 AC #3: a name is never in both blocks),
 *              which is also what a `move --to env` needs.
 *  - `strip` — remove NAME's line (the secret was deleted, or moved to a
 *              prompting store, which is never auto-rendered).
 *
 * Value in hand only. `set` receives the value as an argument and encodes it
 * into one line; nothing here resolves a value, prompts a store, or reads
 * another name. Every other line of the file keeps its bytes and terminator;
 * an in-block comment is kept too (the renderer rewrites it on a full render,
 * the fan-out does not).
 *
 * Three rules close every interleaving (PR #124 review):
 *
 *  Rule C — an operation carries the identity it acted on, captured ONCE (at
 *  its index commit; for plain `enigma render`, at PLAN time) and proceeds only
 *  while the index still says exactly that. A `set` carries its commit
 *  (`updatedAt`, `ref`, `depository`; `setSecret` makes `updatedAt` strictly
 *  increase per entry); a delete `strip` expects NO entry for NAME; a
 *  move-to-prompting `strip` expects the moved entry's commit.
 *
 *  Rule A — never write a superseded value: the Rule C check is re-run under the
 *  target's file lock, immediately before writing or stripping (the index is
 *  re-read lock-free; atomic rename). If it fails, the existing line stays (or
 *  NAME stays absent) and the skip is reported.
 *
 *  Rule B — fan-outs for one NAME are serialized by a per-NAME lock
 *  (`nameLockPath`). Inside it: FIRST check the operation is still current (else
 *  skip entirely), THEN snapshot the holders from the ledger, then write each
 *  target under its own file lock. The NAME lock is always taken before any
 *  target lock. Plain `enigma render` takes no NAME lock; Rules A and C protect it.
 *  The wait is bounded; on timeout every holder gets a warning and an `ok:false`
 *  `lock-timeout` audit line (`lockTimeoutReport`).
 *
 * `fanOutPolicy` is the one place that decides what an operation does; `setSecret`
 * and `enigma import` both call it.
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
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendAuditEvent, auditScopeFields, classifyCleanupError } from '../core/audit.js';
import type { AuditActor } from '../core/audit.js';
import { loadProjectManifest } from '../core/config.js';
import type { ProjectManifest } from '../core/config.js';
import { EnigmaError } from '../core/errors.js';
import { acquireFileLock } from '../core/file-lock.js';
import type { Lock } from '../core/file-lock.js';
import { findIndexEntry, readIndex } from '../core/index-store.js';
import { enigmaHome, renderLockPath } from '../core/paths.js';
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

/** Remove NAME from every holder: the secret was deleted, or moved to a prompting store (never auto-rendered). */
/**
 * What a strip acted on (Rule C). It proceeds only while the index still says exactly that:
 *  - `deleted`: there is NO entry for NAME;
 *  - `entry`: the entry for NAME is the committed prompting-store entry (a NEW secret in a prompting store, or one
 *    moved into it), identified by its commit.
 */
export type StripExpectation = { kind: 'deleted' } | { kind: 'entry'; commit: CommitIdentity };

export interface FanOutRemoveInput {
  name: string;
  projectId: string;
  /** Depository of the entry that was removed or moved (audit only). */
  depository: DepositoryId;
  actor: AuditActor;
  expect: StripExpectation;
}

type Operation = { kind: 'set'; value: string; commit: CommitIdentity } | { kind: 'strip'; expect: StripExpectation };

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

/* ----------------------------- test seams -------------------------- */

let gate: ((commit?: CommitIdentity) => Promise<void> | void) | undefined;

/** Test-only (like `__setLockTimingForTesting`): runs after the index commit and before any fan-out, so a test can order two fan-outs deterministically. */
export function __setFanoutGateForTesting(fn: ((commit?: CommitIdentity) => Promise<void> | void) | undefined): void {
  gate = fn;
}

/**
 * Test-only synchronous hooks at the points the locking rules are about, so a test can prove a rule by
 * acting exactly there (no timing): `afterNameLock` (NAME lock held, nothing checked yet), `beforeTargetLock`
 * (about to take a target's file lock), `afterTargetLock` (file lock held, target revalidated, guard not yet
 * run), `afterGuard` (guard passed, nothing read or written yet). `nameLockRetries` shortens the NAME-lock wait.
 */
export interface FanoutHooks {
  afterNameLock?: (name: string) => void;
  beforeTargetLock?: (file: string) => void;
  afterTargetLock?: (file: string) => void;
  afterGuard?: (file: string) => void;
  nameLockRetries?: number;
  /** Run no fan-out at all: for a test that asserts on a raw file or log shape the fan-out would legitimately change. */
  disabled?: boolean;
}
let hooks: FanoutHooks = {};
export function __setFanoutHooksForTesting(next: FanoutHooks | undefined): void {
  hooks = next ?? {};
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

/** What to run to bring a name's rendered copies up to date: a prompting-store name is only ever rendered explicitly. */
export function renderHint(name: string, depository: DepositoryId): string {
  return isAutoRenderable(depository) ? 'run `enigma render`' : `run \`enigma render ${name}\``;
}

function warningFor(worktree: string, name: string, reason: string): string {
  return `render target ${worktree} was not updated for ${name} (${reason})`;
}

function currentEntry(name: string, projectId: string) {
  return findIndexEntry(readIndex(), name, 'project', projectId);
}

function matchesCommit(entry: { updatedAt: string; ref: string; depository: DepositoryId } | undefined, commit: CommitIdentity): boolean {
  return entry !== undefined && entry.updatedAt === commit.updatedAt && entry.ref === commit.ref && entry.depository === commit.depository;
}

/**
 * Rule C: an operation's notion of "current" was fixed when it committed. It is still current only if the
 * index entry for NAME is exactly what it acted on: the same commit for a set or a move strip, no entry at all
 * for a delete strip. Anything else (a later rotate, a re-create, a move) belongs to a newer operation.
 */
function operationIsCurrent(name: string, projectId: string, op: Operation): boolean {
  const entry = currentEntry(name, projectId);
  if (op.kind === 'set') return matchesCommit(entry, op.commit);
  return op.expect.kind === 'deleted' ? entry === undefined : matchesCommit(entry, op.expect.commit);
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
  let removes = op.kind === 'strip';
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

    hooks.beforeTargetLock?.(peekPath);
    const lock = acquireFileLock(renderLockPath(peekPath));
    try {
      hooks.afterTargetLock?.(peekPath);
      // The lock is held: validate again, before reading or writing (the parent or target may have been swapped).
      const target = validateTargetFile(worktree, lexicalFile);
      if (target !== peekPath) throw new Skip('target-refused');

      // Guard, in the same lock hold as the write (see the header).
      if (!operationIsCurrent(name, projectId, op)) return { status: 'silent' };
      hooks.afterGuard?.(peekPath);

      const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
      try {
        readRenderBlock(current, lexicalFile);
      } catch {
        throw new Skip('damaged-render-block');
      }

      // A name in this file's env block is never in the render block (#107 AC #3): a `set` for it
      // becomes a drop of any stale render line (this is also what a `move --to env` does).
      const inEnvBlock = envBlockNamesOf(current).has(name);
      removes = op.kind === 'strip' || inEnvBlock;
      const result = op.kind === 'set' && !inEnvBlock ? applySet(current, name, op.value) : applyStrip(current, name);

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

const NAME_LOCK_RETRIES = 20;

/** Anchor for the per-NAME fan-out lock (Rule B): one per (projectId, NAME), next to the per-target anchors. */
export function nameLockPath(projectId: string, name: string): string {
  const key = createHash('sha256').update(`${projectId}\0${name}`).digest('hex').slice(0, 32);
  return join(enigmaHome(), 'locks', `fanout-${key}.lock`);
}

/** Take the NAME lock, retrying past the lock helper's short budget (about 10 s in all); then it throws `E_LOCK_TIMEOUT`. */
function acquireNameLock(projectId: string, name: string): Lock {
  const retries = hooks.nameLockRetries ?? NAME_LOCK_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try {
      return acquireFileLock(nameLockPath(projectId, name), 'the render fan-out lock');
    } catch (err) {
      if (!(err instanceof EnigmaError && err.code === 'E_LOCK_TIMEOUT') || attempt >= retries) throw err;
    }
  }
}

/**
 * The NAME lock could not be taken within its budget, so this fan-out cannot be ordered against the one that
 * holds it. Fail honestly instead of waiting forever: for EVERY holder (a read-only ledger snapshot, no NAME lock)
 * and the worktree a create would have added, warn that its rendered copies of NAME may be stale and audit
 * `ok:false` `lock-timeout`. The originating operation stays successful. "Last committed wins" therefore holds
 * within the NAME-lock budget; beyond it every affected target is named, never silently left behind.
 */
function lockTimeoutReport(projectId: string, name: string, op: Operation['kind'], depository: DepositoryId, actor: AuditActor, extraWorktree: string | undefined): string[] {
  const worktrees: string[] = [];
  try {
    for (const t of targetsFor({ projectId, name })) if (!worktrees.includes(t.worktree)) worktrees.push(t.worktree);
  } catch {
    // an unreadable ledger leaves only the generic warning below
  }
  if (extraWorktree !== undefined && !worktrees.includes(extraWorktree)) worktrees.push(extraWorktree);
  const warnings: string[] = [];
  for (const worktree of worktrees) {
    warnings.push(
      `render target ${worktree} was not updated for ${name} (lock-timeout: its rendered copies of ${name} may be stale; ${renderHint(name, depository)})`,
    );
    try {
      appendAuditEvent({
        op: op === 'set' ? 'render' : 'unrender',
        name,
        depository,
        actor,
        ok: false,
        error: 'lock-timeout',
        ...auditScopeFields({ scope: 'project', projectId, projectPath: worktree }),
      });
    } catch {
      // an audit failure must not turn a skipped target into a failed operation
    }
  }
  if (worktrees.length === 0) warnings.push(`render fan-out skipped for ${name} (lock-timeout)`);
  return warnings;
}

/**
 * Rule B: fan-outs for one NAME never overlap. Inside the lock, FIRST `isCurrent()` (is this operation still what
 * the index says? else skip entirely), THEN the holder snapshot, then each target under its own file lock. The NAME
 * lock is always taken before any target lock.
 */
async function withNameLock(
  call: { projectId: string; name: string; op: Operation; depository: DepositoryId; actor: AuditActor; extraWorktree?: string },
  run: () => string[],
  commit?: CommitIdentity,
): Promise<string[]> {
  if (hooks.disabled) return [];
  if (gate) await gate(commit);
  let lock: Lock;
  try {
    lock = acquireNameLock(call.projectId, call.name);
  } catch (err) {
    if (err instanceof EnigmaError && err.code === 'E_LOCK_TIMEOUT') {
      return lockTimeoutReport(call.projectId, call.name, call.op.kind, call.depository, call.actor, call.extraWorktree);
    }
    throw err;
  }
  try {
    hooks.afterNameLock?.(call.name);
    if (!operationIsCurrent(call.name, call.projectId, call.op)) {
      // Superseded: the operation whose commit IS current reconciles every holder, so this one is silent. The one
      // thing it cannot know is the worktree a superseded CREATE would have added: unless the current state's own
      // fan-out already made it a holder, say so.
      if (call.extraWorktree === undefined) return [];
      const holds = targetsFor({ projectId: call.projectId, name: call.name }).some((t) => t.worktree === call.extraWorktree);
      return holds ? [] : [warningFor(call.extraWorktree, call.name, `changed concurrently; ${renderHint(call.name, call.depository)} again`)];
    }
    return run();
  } finally {
    lock.release();
  }
}

/**
 * `set` fan-out: every ledger target of this project that holds NAME, plus (for a brand-new secret in a
 * no-prompt store) the originating worktree. Returns names/paths-only warnings.
 */
export async function fanOutSet(input: FanOutSetInput): Promise<string[]> {
  try {
    const op: Operation = { kind: 'set', value: input.value, commit: input.commit };
    return await withNameLock(
      { projectId: input.projectId, name: input.name, op, depository: input.commit.depository, actor: input.actor, extraWorktree: input.addWorktree ? input.worktree : undefined },
      () => {
        const holders = targetsFor({ projectId: input.projectId, name: input.name });
        const targets: TargetSpec[] = holders.map((h) => ({ worktree: h.worktree, ledgerFile: h.file }));
        if (input.addWorktree && !holders.some((h) => h.worktree === input.worktree)) targets.push({ worktree: input.worktree, isNew: true });
        return runTargets(targets, { name: input.name, projectId: input.projectId, depository: input.commit.depository, actor: input.actor, op });
      },
      input.commit,
    );
  } catch (err) {
    return [`render fan-out skipped for ${input.name} (${reasonFor(err)})`];
  }
}

/** `strip` fan-out over every ledger target of this project that holds NAME (delete, or move to a prompting store). */
export async function fanOutRemove(input: FanOutRemoveInput): Promise<string[]> {
  try {
    const op: Operation = { kind: 'strip', expect: input.expect };
    return await withNameLock(
      { projectId: input.projectId, name: input.name, op, depository: input.depository, actor: input.actor },
      () => {
        const holders = targetsFor({ projectId: input.projectId, name: input.name });
        return runTargets(
          holders.map((h) => ({ worktree: h.worktree, ledgerFile: h.file })),
          { name: input.name, projectId: input.projectId, depository: input.depository, actor: input.actor, op },
        );
      },
    );
  } catch (err) {
    return [`render fan-out skipped for ${input.name} (${reasonFor(err)})`];
  }
}

/**
 * What reconciling rendered copies to the committed state means. Fan-out is RECONCILIATION: under the NAME lock the
 * operation whose commit is the current index state brings EVERY holder of NAME to that state.
 */
export type FanOutPolicy = { action: 'set'; addWorktree: boolean } | { action: 'strip' };

/**
 * The reconciliation table, used by `setSecret`, `enigma move` and `enigma import` so they can never disagree:
 *
 *  | current state of NAME (this commit)                      | every holder is brought to          |
 *  |----------------------------------------------------------|-------------------------------------|
 *  | a no-prompt entry (encrypted, env), value in hand        | SET the value (a NEW secret also adds the originating worktree; an env-block copy drops the render line) |
 *  | a prompting-store entry, an EXISTING name rotated        | SET the value, existing holders only (nothing prompts, nothing is added) |
 *  | a prompting-store entry that is NEW, or moved INTO a prompting store | STRIP NAME and its ledger row |
 *  | no entry (deleted; see `fanOutRemove` with `expect: deleted`) | STRIP |
 *
 * There is no "do nothing" row: an operation that changes nothing a render block shows still reconciles, because
 * it may be the one a superseded operation was relying on (a new keychain secret strips what a racing delete left).
 */
export function fanOutPolicy(input: { moved: boolean; isNew: boolean; depository: DepositoryId }): FanOutPolicy {
  const autoRenderable = isAutoRenderable(input.depository);
  if (autoRenderable) return { action: 'set', addWorktree: input.isNew };
  if (input.moved || input.isNew) return { action: 'strip' };
  return { action: 'set', addWorktree: false };
}

export interface ReconcileInput {
  name: string;
  /** The value already in hand (used only for a `set`). */
  value: string;
  projectId: string;
  /** The worktree a NEW secret is added to (the originating worktree). */
  worktree: string;
  depository: DepositoryId;
  commit: CommitIdentity;
  actor: AuditActor;
  isNew: boolean;
  /** The commit was a `move` (the value is unchanged; only where it lives). */
  moved: boolean;
  /**
   * A worktree that LOST its own copy of NAME in a move (the env depository's block in that worktree's `.env`) and so
   * must gain a render line to keep the variable defined. Only used for a `set`.
   */
  restoreWorktree?: string;
}

/** Reconcile every holder of NAME to the state `commit` just made current. Returns names/paths-only warnings. */
export async function reconcileAfterCommit(input: ReconcileInput): Promise<string[]> {
  const policy = fanOutPolicy({ moved: input.moved, isNew: input.isNew, depository: input.depository });
  if (policy.action === 'strip') {
    return fanOutRemove({ name: input.name, projectId: input.projectId, depository: input.depository, actor: input.actor, expect: { kind: 'entry', commit: input.commit } });
  }
  const restore = input.restoreWorktree !== undefined;
  return fanOutSet({
    name: input.name,
    value: input.value,
    projectId: input.projectId,
    worktree: restore ? input.restoreWorktree! : input.worktree,
    addWorktree: restore || policy.addWorktree,
    commit: input.commit,
    actor: input.actor,
  });
}
