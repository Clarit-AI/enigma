/**
 * Per-secret operation lock (Issue #125).
 *
 * Every change to one secret — `setSecret` (set / rotate / import), `deleteSecret` and `enigma move` — holds this
 * lock across its WHOLE sequence: depository write -> index commit -> old-copy cleanup -> render fan-out. Two
 * changes to the same (scope id, NAME) therefore never interleave, in any depository. That closes the move-cleanup
 * data loss: a cleanup can no longer delete a copy that a concurrent writer stored at the same address (env's bare
 * NAME, encrypted's `<id>/NAME`) between its "still referenced?" read and its delete, because that writer cannot
 * run until the cleanup is done.
 *
 * `enigma import` is the one holder of several locks (Issue #133): `acquireSecretOpLocks` takes every entry's lock,
 * in `opLockOrder`, for the whole batch (stores, `.env` rewrite and render fan-out), and each entry's `setSecret`
 * runs with `opLockHeld`. Every other holder takes exactly one, so no cycle is possible: two imports acquire in the
 * same order, and a single-lock holder never waits for a second operation lock while holding its first.
 *
 * Lock order: this lock first, then the index lock (`mutateIndex`), the render NAME lock and target locks
 * (`src/render/fanout.ts`) and the encrypted vault lock — all of which are taken and released inside it. It may be
 * held across a depository prompt (Keychain, Touch ID, 1Password), so it is the async variant: a waiter yields the
 * event loop, and gives up with `E_LOCK_TIMEOUT` after `ASYNC_LOCK_TIMEOUT_MS` naming the secret, never a value.
 *
 * Not re-entrant: `flock(2)` binds to the open file description, so a nested acquire in the same call chain waits
 * on itself. A caller that already holds the lock (`enigma move` calling `setSecret`) passes `opLockHeld`.
 */
import { ASYNC_LOCK_TIMEOUT_MS, acquireFileLockAsync } from '../core/file-lock.js';
import type { Lock } from '../core/file-lock.js';
import { EnigmaError } from '../core/errors.js';
import { secretOpLockPath } from '../core/paths.js';
import type { Scope } from '../core/index-store.js';

/** The lock's scope key: `global`, or the project id for a project secret. */
export function opLockScopeId(scope: Scope, projectId: string | undefined): string {
  return scope === 'global' ? 'global' : `project:${projectId ?? ''}`;
}

let bypass = false;

/**
 * Test-only: run operations WITHOUT the operation lock, so a suite can still drive the cross-command interleavings
 * the lock now prevents (the render fan-out's Rules A-C stay as defence in depth and keep their tests). Never read
 * from the environment; only test code calls it. Restore in `afterEach`.
 */
export function __setSecretOpLockBypassForTesting(on: boolean): void {
  bypass = on;
}

async function acquireOne(name: string, scopeId: string, timeoutMs?: number): Promise<Lock> {
  try {
    return await acquireFileLockAsync(secretOpLockPath(name, scopeId), `the lock for ${name}`, { timeoutMs });
  } catch (err) {
    if (err instanceof EnigmaError && err.code === 'E_LOCK_TIMEOUT') {
      throw new EnigmaError({
        code: 'E_LOCK_TIMEOUT',
        message: `another change to ${name} is in progress; try again when it finishes`,
        secretName: name,
      });
    }
    throw err;
  }
}

let stepDelayMs = 0;

/**
 * Test-only: pause between the locks of one `acquireSecretOpLocks` batch, so a real-process test can widen the
 * window in which two batches interleave (Issue #133's opposite-order deadlock test). Never read from the
 * environment here; only test code calls it.
 */
export function __setOpLocksStepDelayForTesting(ms: number): void {
  stepDelayMs = ms;
}

/** The names `acquireSecretOpLocks` locks, in the order it takes them: deduplicated, sorted by code unit. */
export function opLockOrder(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Thrown by `acquireSecretOpLocks`: the batch stopped at `secretName`, and every lock it had taken is released. */
export class OpLocksError extends Error {
  override readonly name = 'OpLocksError';
  constructor(
    readonly secretName: string,
    override readonly cause: unknown,
  ) {
    super(`could not take the operation lock for ${secretName}`);
  }
}

/**
 * Issue #133: take the operation lock of EVERY name in `names`, in `opLockOrder`, for a caller that changes several
 * secrets as one batch (`enigma import`). One deadline covers the whole batch (`ASYNC_LOCK_TIMEOUT_MS`), not one per
 * name. On any failure every lock already taken is released, then `OpLocksError` names the secret the batch stopped
 * at (`secretName`; its `cause` is the underlying `EnigmaError`). The returned `release()` releases them all; a second call is a
 * no-op.
 */
export async function acquireSecretOpLocks(names: readonly string[], scopeId: string): Promise<{ release(): void }> {
  if (bypass) return { release: () => {} };
  const held: Lock[] = [];
  const releaseAll = (): void => {
    for (const lock of held.splice(0).reverse()) lock.release();
  };
  const deadline = Date.now() + ASYNC_LOCK_TIMEOUT_MS;
  for (const name of opLockOrder(names)) {
    try {
      held.push(await acquireOne(name, scopeId, Math.max(0, deadline - Date.now())));
      if (stepDelayMs > 0) await new Promise((r) => setTimeout(r, stepDelayMs));
    } catch (err) {
      releaseAll();
      throw new OpLocksError(name, err);
    }
  }
  return { release: releaseAll };
}

export async function withSecretOpLock<T>(name: string, scopeId: string, fn: () => Promise<T>): Promise<T> {
  if (bypass) return fn();
  const lock = await acquireOne(name, scopeId);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
