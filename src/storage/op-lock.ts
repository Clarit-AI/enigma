/**
 * Per-secret operation lock (Issue #125).
 *
 * Every change to one secret — `setSecret` (set / rotate / import), `deleteSecret` and `enigma move` — holds this
 * lock across its WHOLE sequence: depository write -> index commit -> old-copy cleanup -> render fan-out. Two
 * changes to the same (scope id, NAME) therefore never interleave, in any depository. Exception: an import entry
 * skips its own fan-out (the batch renders after the whole batch commits, outside this lock), so a change racing
 * the import between that entry's commit and the batch fan-out can leave a rendered line stale or missing (#133). That closes the move-cleanup
 * data loss: a cleanup can no longer delete a copy that a concurrent writer stored at the same address (env's bare
 * NAME, encrypted's `<id>/NAME`) between its "still referenced?" read and its delete, because that writer cannot
 * run until the cleanup is done.
 *
 * Lock order: this lock first, then the index lock (`mutateIndex`), the render NAME lock and target locks
 * (`src/render/fanout.ts`) and the encrypted vault lock — all of which are taken and released inside it. It may be
 * held across a depository prompt (Keychain, Touch ID, 1Password), so it is the async variant: a waiter yields the
 * event loop, and gives up with `E_LOCK_TIMEOUT` after `ASYNC_LOCK_TIMEOUT_MS` naming the secret, never a value.
 *
 * Not re-entrant: `flock(2)` binds to the open file description, so a nested acquire in the same call chain waits
 * on itself. A caller that already holds the lock (`enigma move` calling `setSecret`) passes `opLockHeld`.
 */
import { acquireFileLockAsync } from '../core/file-lock.js';
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

export async function withSecretOpLock<T>(name: string, scopeId: string, fn: () => Promise<T>): Promise<T> {
  if (bypass) return fn();
  let lock;
  try {
    lock = await acquireFileLockAsync(secretOpLockPath(name, scopeId), `the lock for ${name}`);
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
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
