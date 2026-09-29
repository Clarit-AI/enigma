/* ------------------------------------------------------------------ *
 *  Render ledger (Issue #106)                                         *
 * ------------------------------------------------------------------ *
 *
 * The render ledger records, per (projectId, worktree, file) target,
 * the names last rendered there and the timestamp. It is the
 * per-worktree axis the index lacks — the index knows which names a
 * project has in which depository, but not which of them have been
 * rendered into the worktree's `.env` (or wherever `.enigma.json` says).
 *
 * Invariants:
 * - NAMES ONLY. No value, ref, audit reason, or anything derived from a
 *   secret ever appears in the ledger bytes (ADR-001).
 * - The ledger file lives at `<enigmaHome>/render-ledger.json` and is
 *   mode `0600`. Its parent dir is `0700`.
 * - Every write is a read-modify-write under the ledger's OWN lock
 *   (kernel `flock(2)` on the ledger's persistent anchor) so a
 *   concurrent writer can never silently overwrite another writer's
 *   just-committed target. The `acquireFileLock(renderLedgerLockPath())`
 *   call returns a `Lock` whose `release()` runs in `finally`.
 * - The on-disk JSON is written atomically via `writeJsonFileAtomic`
 *   (tmp + rename in the same dir) so a partial write is never visible
 *   to the next reader.
 * - Missing file → empty ledger. Corrupt JSON → `E_CONFIG_CORRUPT`
 *   naming the path. Never a raw `SyntaxError` (precedent: `loadConfig`
 *   at `src/core/config.ts`).
 * - Mutations are idempotent on the (projectId, worktree, file) key:
 *   `upsertTarget` with the same key merges `names[]` (sorted-unique)
 *   and refreshes `renderedAt`. `removeNames` is the inverse for any
 *   name the caller knows is no longer present in a target.
 * - `targetsFor` is lock-free: a writer's atomic-rename commits either
 *   the pre-mutation or the post-mutation shape, never a partial mix,
 *   so a reader that sees one snapshot is consistent.
 */
import { acquireFileLock } from '../core/file-lock.js';
import { renderLedgerLockPath, renderLedgerPath } from '../core/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../core/secure-file.js';

/** One rendered target: a (projectId, worktree, file) row carrying the names written there. */
export interface RenderLedgerTarget {
  /** Repository identity id (`projectId(cwd)` from Issue #67) the render belongs to. */
  projectId: string;
  /** Lexical absolute path of the worktree the render was made for. */
  worktree: string;
  /** Absolute path of the file the names were rendered into (e.g. `<worktree>/.env`). */
  file: string;
  /** Names written into `file`. Sorted, deduplicated, never a value. */
  names: string[];
  /** ISO-8601 timestamp of the last successful `upsertTarget` for this target. */
  renderedAt: string;
}

export interface RenderLedgerFile {
  version: 1;
  targets: RenderLedgerTarget[];
}

export const RENDER_LEDGER_VERSION = 1 as const;

const EMPTY_LEDGER: RenderLedgerFile = { version: RENDER_LEDGER_VERSION, targets: [] };

/**
 * Inputs accepted by `upsertTarget`. `renderedAt` is assigned by the
 * ledger itself (server time, ISO-8601), so the caller never sets it —
 * prevents accidental clock skew and keeps the persisted shape uniform.
 */
export interface UpsertTargetInput {
  projectId: string;
  worktree: string;
  file: string;
  names: string[];
}

/** Filter for `targetsFor` — both fields optional; empty/missing means "no filter on that axis". */
export interface TargetsForFilter {
  projectId?: string;
  name?: string;
}

/** Type-narrowing predicate for `pruneTargets`. Pure (no side effects). */
export type TargetPredicate = (target: RenderLedgerTarget) => boolean;

/* ----------------------------- internals --------------------------- */

/** Strict equality on the (projectId, worktree, file) target key. */
function sameKey(a: RenderLedgerTarget, b: { projectId: string; worktree: string; file: string }): boolean {
  return a.projectId === b.projectId && a.worktree === b.worktree && a.file === b.file;
}

/** Merge `incoming` into the existing `names[]`, deduped, sorted ascending. */
function mergeNames(existing: readonly string[], incoming: readonly string[]): string[] {
  const set = new Set<string>(existing);
  for (const name of incoming) set.add(name);
  return [...set].sort();
}

/**
 * Read the ledger from disk. Missing file → the empty ledger. Corrupt
 * JSON → `E_CONFIG_CORRUPT` naming the path (never a raw `SyntaxError`,
 * matching `loadConfig` at `src/core/config.ts`).
 *
 * Lock-free: the on-disk shape is always the post-commit shape of some
 * completed write (writes are atomic rename), so any reader sees a
 * consistent snapshot. Callers that need a "read then decide" pattern
 * should use one of the mutating helpers, which take the ledger's own
 * lock and re-read inside the critical section.
 */
export function readLedger(): RenderLedgerFile {
  return readJsonFile<RenderLedgerFile>(renderLedgerPath(), EMPTY_LEDGER, 'E_CONFIG_CORRUPT');
}

/**
 * Upsert a target under the ledger's own lock.
 *
 * - Target key is `(projectId, worktree, file)` — same project + same
 *   worktree + same output file merges `names[]` and refreshes
 *   `renderedAt`.
 * - `names` is deduped and sorted ascending before persistence so the
 *   on-disk shape is stable (no caller-visible reordering surprises).
 * - An empty `names` removes the target (the semantics of "rendered
 *   nothing" is "no record") rather than persisting an empty array
 *   forever.
 * - No-op on `names` empty AND target already absent (we still re-read
 *   and re-write the file when there is no change; that is acceptable
 *   for the public call sites, which always pass at least one name).
 */
export function upsertTarget(input: UpsertTargetInput): RenderLedgerTarget | undefined {
  if (input.names.length === 0) {
    removeTargetsMatching(input);
    return undefined;
  }
  const lock = acquireFileLock(renderLedgerLockPath());
  try {
    const current = readLedger();
    const now = new Date().toISOString();
    const sortedNames = mergeNames([], input.names);
    const idx = current.targets.findIndex((t) => sameKey(t, input));
    if (idx === -1) {
      const created: RenderLedgerTarget = {
        projectId: input.projectId,
        worktree: input.worktree,
        file: input.file,
        names: sortedNames,
        renderedAt: now,
      };
      const next: RenderLedgerFile = { ...current, targets: [...current.targets, created] };
      writeJsonFileAtomic(renderLedgerPath(), next);
      return created;
    }
    const prev = current.targets[idx]!;
    const merged: RenderLedgerTarget = {
      ...prev,
      names: mergeNames(prev.names, input.names),
      renderedAt: now,
    };
    const targets = current.targets.slice();
    targets[idx] = merged;
    writeJsonFileAtomic(renderLedgerPath(), { ...current, targets });
    return merged;
  } finally {
    lock.release();
  }
}

/**
 * Remove every occurrence of `names` from every target's `names[]`. A
 * target whose `names[]` becomes empty is dropped from the ledger
 * entirely. No-op when `names` is empty or no target carries any of the
 * names.
 */
export function removeNames(names: readonly string[]): void {
  if (names.length === 0) return;
  const lock = acquireFileLock(renderLedgerLockPath());
  try {
    const current = readLedger();
    const drop = new Set(names);
    const next: RenderLedgerTarget[] = [];
    for (const target of current.targets) {
      const remaining = target.names.filter((n) => !drop.has(n));
      if (remaining.length > 0) next.push({ ...target, names: remaining });
    }
    if (next.length === current.targets.length) return;
    writeJsonFileAtomic(renderLedgerPath(), { ...current, targets: next });
  } finally {
    lock.release();
  }
}

/**
 * In-memory filter over the ledger. Lock-free — see the read-modify-write
 * note on `readLedger`. `projectId` and `name` are independent filters
 * (AND); omit either to skip that axis. Empty/missing filter returns the
 * full target list (defensive copy).
 */
export function targetsFor(filter: TargetsForFilter = {}): RenderLedgerTarget[] {
  const ledger = readLedger();
  return ledger.targets.filter((t) => {
    if (filter.projectId !== undefined && t.projectId !== filter.projectId) return false;
    if (filter.name !== undefined && !t.names.includes(filter.name)) return false;
    return true;
  });
}

/**
 * Remove every target for which `predicate(target)` is true. Useful for
 * the doctor / SessionStart surfaces (Issue #110) that prune ledger rows
 * pointing at worktrees that no longer exist. The predicate runs under
 * the ledger's own lock, so concurrent upserts cannot resurrect a
 * pruned target mid-walk.
 */
export function pruneTargets(predicate: TargetPredicate): void {
  const lock = acquireFileLock(renderLedgerLockPath());
  try {
    const current = readLedger();
    const next = current.targets.filter((t) => !predicate(t));
    if (next.length === current.targets.length) return;
    writeJsonFileAtomic(renderLedgerPath(), { ...current, targets: next });
  } finally {
    lock.release();
  }
}

/**
 * Internal: drop every target with the given (projectId, worktree, file)
 * key under the ledger's own lock. Used by `upsertTarget` when the
 * incoming `names` is empty ("rendered nothing" → no record).
 *
 * Not exported — `pruneTargets(predicate)` is the public escape hatch.
 */
function removeTargetsMatching(input: { projectId: string; worktree: string; file: string }): void {
  const lock = acquireFileLock(renderLedgerLockPath());
  try {
    const current = readLedger();
    const next = current.targets.filter((t) => !sameKey(t, input));
    if (next.length === current.targets.length) return;
    writeJsonFileAtomic(renderLedgerPath(), { ...current, targets: next });
  } finally {
    lock.release();
  }
}