// ESM module namespaces aren't spy-able in place (vitest: "Cannot redefine
// property"), so simulating a SPECIFIC fs failure/race inside
// `acquireIndexLock` needs a hoisted vi.mock, not a runtime vi.spyOn — same
// pattern as test/unit/storage/import-commit-fs-mocked.test.ts. Kept
// separate from index-store.test.ts so the bulk of ordinary lock tests
// there stay simple and unaffected by this.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnigmaError } from '../../src/core/errors.js';

/** Set to a lock path: the NEXT writeFileSync call throws once, regardless of target. */
let writeFileSyncShouldThrowOnce = false;
/** Set to a lock path: the NEXT renameSync call FROM that path throws a simulated ENOENT once. */
let renameShouldThrowENOENTFor: string | undefined;
/**
 * Set to `{ lockPath, freshBody }`: the NEXT renameSync call FROM lockPath
 * overwrites the file with `freshBody` immediately before the real OS
 * rename executes — simulating "between our read of a stale lock and our
 * tombstone rename, the original holder finished and a new process
 * re-acquired the lock with a fresh timestamp", so the content our rename
 * actually captures into the tombstone is the fresh one.
 */
let stealLiveLockOnRename: { lockPath: string; freshBody: string } | undefined;
/**
 * Set together with `afterRenameHook`: when a renameSync FROM `afterRenameFrom`
 * completes successfully, the hook runs once (then both are cleared). This is
 * the deterministic injection point for a SECOND breaker racing in the window
 * between "first breaker moved the stale lock to its tombstone" and "first
 * breaker re-opens the lock path" — the only moment a concurrent acquirer can
 * steal the open slot.
 */
let afterRenameFrom: string | undefined;
let afterRenameHook: (() => void) | undefined;
const renameCalls: Array<[unknown, unknown]> = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (path: unknown, data: unknown, opts: unknown) => {
      if (writeFileSyncShouldThrowOnce) {
        writeFileSyncShouldThrowOnce = false;
        throw new Error('simulated: disk full writing lock body');
      }
      return actual.writeFileSync(path as never, data as never, opts as never);
    },
    renameSync: (from: unknown, to: unknown) => {
      if (stealLiveLockOnRename !== undefined && from === stealLiveLockOnRename.lockPath) {
        const { freshBody } = stealLiveLockOnRename;
        stealLiveLockOnRename = undefined; // only once
        actual.writeFileSync(from as never, freshBody, { mode: 0o600 });
      }
      renameCalls.push([from, to]);
        if (renameShouldThrowENOENTFor !== undefined && from === renameShouldThrowENOENTFor) {
          renameShouldThrowENOENTFor = undefined; // only the losing attempt
          const err = new Error('simulated: another breaker already moved this') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        const result = actual.renameSync(from as never, to as never);
        if (afterRenameFrom !== undefined && from === afterRenameFrom) {
          const hook = afterRenameHook;
          afterRenameFrom = undefined;
          afterRenameHook = undefined;
          hook?.();
        }
        return result;
      },
  };
});

const {
  __setLockTimingForTesting,
  LOCK_STALE_MS,
  mutateIndex,
  readIndex,
  upsertIndexEntry,
} = await import('../../src/core/index-store.js');
const { indexLockPath } = await import('../../src/core/paths.js');
const { existsSync } = await import('node:fs');

describe('index-store mutateIndex lock — fs-failure and race injection (Issue #66, PR #77 review)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  const originalTimings = {
    staleMs: LOCK_STALE_MS,
    retryIntervalMs: 10,
    maxAttempts: 50,
  };

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    writeFileSyncShouldThrowOnce = false;
    renameShouldThrowENOENTFor = undefined;
    stealLiveLockOnRename = undefined;
    afterRenameFrom = undefined;
    afterRenameHook = undefined;
    renameCalls.length = 0;
  });

  afterEach(() => {
    __setLockTimingForTesting(originalTimings);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('unlinks the lock file if writing its body fails after openSync succeeded, and does not leak the lock', () => {
    const lockPath = indexLockPath();
    writeFileSyncShouldThrowOnce = true;

    try {
      mutateIndex((cur) => cur);
      expect.unreachable('mutateIndex should have surfaced the write failure');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_LOCK_TIMEOUT');
    }

    // No leaked lock file — the failed acquire cleaned up after itself.
    expect(existsSync(lockPath)).toBe(false);

    // A subsequent acquire is not blocked by a leaked lock.
    mutateIndex((cur) => upsertIndexEntry(cur, { name: 'OPENAI_API_KEY', scope: 'global', depository: 'encrypted', ref: 'global/OPENAI_API_KEY', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
    expect(readIndex().entries).toHaveLength(1);
  });

  it('a losing breaker sees ENOENT on the tombstone rename (another breaker already moved it) and retries instead of crashing', () => {
    const lockPath = indexLockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const staleCreatedAtMs = Date.now() - LOCK_STALE_MS - 5_000;
    writeFileSync(lockPath, `deadbeefdeadbeefdeadbeefdeadbeef\n1\n${staleCreatedAtMs}\n`, { mode: 0o600 });
    renameShouldThrowENOENTFor = lockPath;

    // Must not throw — the simulated ENOENT is treated as "retry
    // acquisition", not surfaced as a raw fs error.
    mutateIndex((cur) => upsertIndexEntry(cur, { name: 'OPENAI_API_KEY', scope: 'global', depository: 'encrypted', ref: 'global/OPENAI_API_KEY', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));

    // At least two rename attempts on the lock path: the losing (ENOENT)
    // one and the retry that actually broke the still-stale lock.
    expect(renameCalls.filter(([from]) => from === lockPath).length).toBeGreaterThanOrEqual(2);
    expect(readIndex().entries).toHaveLength(1);
  });

  it('restores a lock stolen mid stale-break — when the tombstone content turns out fresh, it never proceeds and never removes the live owner\'s lock', () => {
    const lockPath = indexLockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    // Looks stale on our initial read...
    const staleCreatedAtMs = Date.now() - LOCK_STALE_MS - 5_000;
    writeFileSync(lockPath, `deadbeefdeadbeefdeadbeefdeadbeef\n1\n${staleCreatedAtMs}\n`, { mode: 0o600 });

    const freshToken = 'cafef00dcafef00dcafef00dcafef00d';
    const freshBody = `${freshToken}\n2\n${Date.now()}\n`;
    stealLiveLockOnRename = { lockPath, freshBody };

    __setLockTimingForTesting({ staleMs: LOCK_STALE_MS, retryIntervalMs: 5, maxAttempts: 3 });

    try {
      mutateIndex((cur) => cur);
      expect.unreachable('must not proceed on a stolen live lock');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_LOCK_TIMEOUT');
    }

    // The fresh (live) lock was restored to lockPath, byte-for-byte, and
    // left alone — we never unlinked or overwrote the real owner's lock.
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(freshBody);
  });

  it('two breakers on one stale lock: at most one holds it at a time (Issue #66, PR #77 review)', () => {
    const lockPath = indexLockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const staleToken = 'deadbeefdeadbeefdeadbeefdeadbeef';
    writeFileSync(lockPath, `${staleToken}\n1\n${Date.now() - LOCK_STALE_MS - 5_000}\n`, { mode: 0o600 });

    const entry = (name: string) => ({
      name,
      scope: 'global' as const,
      depository: 'encrypted' as const,
      ref: `global/${name}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const order: string[] = [];
    let concurrentHolders = 0;
    let maxConcurrentHolders = 0;
    let thirdDeltaRan = false;

    // Shrink the live-lock retry budget so a blocked acquirer times out in
    // milliseconds rather than the production ~500 ms.
    __setLockTimingForTesting({ staleMs: LOCK_STALE_MS, retryIntervalMs: 1, maxAttempts: 3 });

    // Breaker B runs inside breaker A's stale-break window: the hook fires
    // right after A's tombstone rename has moved the stale lock aside — the
    // exact moment a second breaker can win the open slot. This is the only
    // way to interleave two fully-synchronous acquire paths deterministically.
    afterRenameFrom = lockPath;
    afterRenameHook = () => {
      mutateIndex((cur) => {
        concurrentHolders += 1;
        maxConcurrentHolders = Math.max(maxConcurrentHolders, concurrentHolders);
        order.push('B');
        // B must hold a fresh lock of its own — never the stale one it broke.
        const heldToken = readFileSync(lockPath, 'utf8').split('\n')[0];
        expect(heldToken).not.toBe(staleToken);
        // While B holds, a third acquirer must NOT enter its critical section.
        let thirdErr: unknown;
        try {
          mutateIndex((inner) => {
            thirdDeltaRan = true;
            return inner;
          });
        } catch (err) {
          thirdErr = err;
        }
        expect(thirdErr).toBeInstanceOf(EnigmaError);
        expect((thirdErr as EnigmaError).code).toBe('E_LOCK_TIMEOUT');
        concurrentHolders -= 1;
        return upsertIndexEntry(cur, entry('NAME_B'));
      });
    };

    // Breaker A: breaks the same stale lock, re-acquires after B is done,
    // and its re-read must see B's committed entry (no lost update).
    mutateIndex((cur) => {
      concurrentHolders += 1;
      maxConcurrentHolders = Math.max(maxConcurrentHolders, concurrentHolders);
      order.push('A');
      const heldToken = readFileSync(lockPath, 'utf8').split('\n')[0];
      expect(heldToken).not.toBe(staleToken);
      concurrentHolders -= 1;
      return upsertIndexEntry(cur, entry('NAME_A'));
    });

    // B ran in A's break window and A ran after; never two holders at once.
    expect(order).toEqual(['B', 'A']);
    expect(thirdDeltaRan).toBe(false);
    expect(maxConcurrentHolders).toBe(1);
    // Both writers' deltas landed — A's locked re-read saw B's entry.
    expect(readIndex().entries.map((e) => e.name).sort()).toEqual(['NAME_A', 'NAME_B']);
    expect(existsSync(lockPath)).toBe(false);
  });
});
