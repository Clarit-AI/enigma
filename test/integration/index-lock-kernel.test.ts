// Real-process evidence for the kernel flock index lock (Issue #66).
//
// These tests spawn REAL child processes (spawn passes through
// test/setup.ts's guard, which only intercepts execFile) that contend on
// one anchor through the committed native addon — the same artifact a
// marketplace install runs. They replace the deleted name-based
// stale/tombstone suite, which simulated races with fs mocks; these do not
// simulate: the kernel is the arbiter.
//
// Covered here: concurrent writers single holder; paused live owner times
// out and is never evicted; killed holder's lock is immediately
// recoverable (kernel death release); a leftover legacy body is
// irrelevant. fd-cleanup/delta-failure lives in index-store.test.ts (it is
// per-process introspection of the acquire path).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setLockTimingForTesting, LOCK_MAX_ATTEMPTS, LOCK_RETRY_INTERVAL_MS, mutateIndex, readIndex, upsertIndexEntry } from '../../src/core/index-store.js';
import { indexLockPath, renderLockPath } from '../../src/core/paths.js';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'index-lock-worker.mjs');
const ADDON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'enigma', 'native', `${process.platform}-${process.arch}`, 'index-lock.node');

function runWorker(args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('exit', (code) => resolvePromise({ code, stdout }));
  });
}

function spawnHold(behavior: 'pause' | 'park'): Promise<{ pid: number; child: ReturnType<typeof spawn> }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [WORKER, 'hold', ADDON, indexLockPath(), behavior], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('LOCKED')) resolvePromise({ pid: child.pid!, child });
    });
    child.on('exit', () => {
      // Resolved already in the normal case; harmless otherwise.
    });
  });
}

/**
 * SIGKILLs a spawned holder and resolves once its 'exit' event has fired —
 * the point where the kernel has actually released the holder's flock. The
 * listener is registered BEFORE the signal so the exit can never be missed,
 * and an already-dead child resolves immediately (cleanup can never hang).
 */
async function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
  const exited =
    child.exitCode === null && child.signalCode === null
      ? new Promise((resolvePromise) => child.once('exit', resolvePromise))
      : Promise.resolve();
  child.kill('SIGKILL');
  await exited;
}

function entry(name: string) {
  return {
    name,
    scope: 'global' as const,
    depository: 'encrypted' as const,
    ref: `global/${name}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('index lock — real processes against the committed flock addon (Issue #66)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  const originalTimings = { retryIntervalMs: LOCK_RETRY_INTERVAL_MS, maxAttempts: LOCK_MAX_ATTEMPTS };

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-kernel-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    __setLockTimingForTesting(originalTimings);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('concurrent writers: 4 real processes x 20 read-modify-write cycles keep every update (single holder at all times)', async () => {
    const counterFile = join(tmpHome, 'counter');
    writeFileSync(counterFile, '0');
    const anchor = indexLockPath();
    mkdirSync(dirname(anchor), { recursive: true, mode: 0o700 });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        runWorker(['counter', ADDON, anchor, counterFile, '20', '2']),
      ),
    );
    for (const r of results) expect(r.code).toBe(0);

    // Every one of the 80 non-atomic increments landed: two holders could
    // never overlap inside the read → sleep → write window.
    expect(readFileSync(counterFile, 'utf8')).toBe('80');
  });

  it('paused live owner: waits out the retry budget and times out — never evicted', async () => {
    const { child } = await spawnHold('pause');
    try {
      const lockPath = indexLockPath();
      const heldIno = statSync(lockPath).ino;

      __setLockTimingForTesting({ retryIntervalMs: 5, maxAttempts: 3 });
      try {
        mutateIndex((cur) => cur);
        expect.unreachable('mutateIndex should have timed out against the paused holder');
      } catch (err) {
        expect((err as { code?: string }).code).toBe('E_LOCK_TIMEOUT');
      }

      // Never evicted: same inode as the paused holder's anchor.
      expect(statSync(lockPath).ino).toBe(heldIno);
    } finally {
      // Await the holder's actual death: the kernel drops its flock when the
      // fd dies with the process, so reacquiring before 'exit' races the
      // release — the recovery below must observe a DEAD holder, not a
      // still-dying one.
      await killAndWait(child);
    }

    // The paused holder is dead → the kernel released its lock → recovery
    // is immediate (no staleness threshold, no body inspection).
    mutateIndex((cur) => upsertIndexEntry(cur, entry('RECOVERED')));
    expect(readIndex().entries.map((e) => e.name)).toEqual(['RECOVERED']);
  });

  it('killed holder: kernel drops the lock on SIGKILL and the next acquire wins immediately', async () => {
    const { pid, child } = await spawnHold('park');
    child.kill('SIGKILL');
    await new Promise((resolvePromise) => child.on('exit', resolvePromise));
    expect(pid).toBeGreaterThan(0);

    __setLockTimingForTesting({ retryIntervalMs: 5, maxAttempts: 40 });
    mutateIndex((cur) => upsertIndexEntry(cur, entry('AFTER_KILL')));
    expect(readIndex().entries.map((e) => e.name)).toEqual(['AFTER_KILL']);
  });

  it('leftover legacy/empty body in the anchor is irrelevant — acquisition and rewriting both work', async () => {
    const anchor = indexLockPath();
    mkdirSync(dirname(anchor), { recursive: true, mode: 0o700 });
    writeFileSync(anchor, '', { mode: 0o600 });

    const counterFile = join(tmpHome, 'counter');
    writeFileSync(counterFile, '0');
    // A real process acquires fine despite the garbage body — content is
    // never consulted for safety.
    const r = await runWorker(['counter', ADDON, anchor, counterFile, '1', '1']);
    expect(r.code).toBe(0);
    expect(readFileSync(counterFile, 'utf8')).toBe('1');

    // The production acquire path rewrites the body with informational
    // metadata after the lock is held.
    mutateIndex((cur) => upsertIndexEntry(cur, entry('META_WRITER')));
    const lines = readFileSync(anchor, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(Number(lines[0])).toBe(process.pid);
    expect(Number.isFinite(Number(lines[1]))).toBe(true);
  });

  it('exclusion also holds for the TS acquire path against a real process holder (mutateIndex vs worker)', async () => {
    const { child } = await spawnHold('park');
    try {
      __setLockTimingForTesting({ retryIntervalMs: 5, maxAttempts: 2 });
      expect(() => mutateIndex((cur) => cur)).toThrowError(
        expect.objectContaining({ code: 'E_LOCK_TIMEOUT' }),
      );
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolvePromise) => child.on('exit', resolvePromise));
    }
    mutateIndex((cur) => upsertIndexEntry(cur, entry('FREE')));
    expect(readIndex().entries.map((e) => e.name)).toEqual(['FREE']);
  });
});

/* ------------------------------------------------------------------ *
 *  Generic acquireFileLock — Issue #106                               *
 * ------------------------------------------------------------------ *
 *
 * These integration tests prove the same kernel-held exclusion contract
 * holds for arbitrary anchor paths — what `acquireFileLock(lockPath)`
 * delivers to the rest of the codebase (e.g. the render-target locks at
 * `<configDir>/locks/<sha256>.lock`). The kernel `flock(2)` on a
 * description per anchor is the arbiter; cross-anchor exclusion does not
 * exist (it must not exist), and the same-anchor exclusion we already
 * prove for the index lock above applies to every lock path equally.
 */
describe('acquireFileLock — real processes against the committed flock addon (Issue #106)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-filelock-rp-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('two processes locking two DIFFERENT anchors proceed without waiting (AC #2, cross-anchor non-contention)', async () => {
    const anchorA = join(tmpHome, 'a.lock');
    const anchorB = join(tmpHome, 'b.lock');
    mkdirSync(dirname(anchorA), { recursive: true, mode: 0o700 });

    // Both children do a real `flock` acquire + 50ms hold + release +
    // re-acquire cycle (20 iters). If cross-anchor contention existed,
    // the total elapsed would be ~20 * 50ms * 2 ≈ 2 seconds instead of
    // ~1 second. We assert an order-of-magnitude tighter bound than the
    // production retry budget.
    const counterA = join(tmpHome, 'a.counter');
    const counterB = join(tmpHome, 'b.counter');
    writeFileSync(counterA, '0');
    writeFileSync(counterB, '0');

    const t0 = Date.now();
    const results = await Promise.all([
      runWorker(['counter', ADDON, anchorA, counterA, '20', '50']),
      runWorker(['counter', ADDON, anchorB, counterB, '20', '50']),
    ]);
    const elapsed = Date.now() - t0;
    for (const r of results) expect(r.code).toBe(0);
    expect(readFileSync(counterA, 'utf8')).toBe('20');
    expect(readFileSync(counterB, 'utf8')).toBe('20');
    // Production retry budget is ~500ms; cross-anchor parallel must
    // complete well inside one retry window on top of the work itself.
    expect(elapsed).toBeLessThan(LOCK_MAX_ATTEMPTS * LOCK_RETRY_INTERVAL_MS + 1500);
  });

  it('two worktrees with the same relative `.env` basename get distinct anchors (clarification comment)', () => {
    const wt1 = join(tmpHome, 'wt1');
    const wt2 = join(tmpHome, 'wt2');
    mkdirSync(wt1, { recursive: true, mode: 0o755 });
    mkdirSync(wt2, { recursive: true, mode: 0o755 });
    const env1 = join(wt1, '.env');
    const env2 = join(wt2, '.env');
    expect(renderLockPath(env1)).not.toBe(renderLockPath(env2));
  });

  it('two worktrees with the same `.env` basename contend on DIFFERENT anchors and parallel renders both finish (clarification comment)', async () => {
    const wt1 = join(tmpHome, 'wt1');
    const wt2 = join(tmpHome, 'wt2');
    mkdirSync(wt1, { recursive: true, mode: 0o755 });
    mkdirSync(wt2, { recursive: true, mode: 0o755 });
    const env1 = join(wt1, '.env');
    const env2 = join(wt2, '.env');
    const anchor1 = renderLockPath(env1);
    const anchor2 = renderLockPath(env2);
    expect(anchor1).not.toBe(anchor2);

    // The render-lock anchors live under <ENIGMA_HOME>/locks/. The
    // production acquire path auto-creates that dir; the worker fixture
    // uses raw openSync and does not. Pre-create it for the children.
    mkdirSync(dirname(anchor1), { recursive: true, mode: 0o700 });

    const counter1 = join(wt1, 'counter');
    const counter2 = join(wt2, 'counter');
    writeFileSync(counter1, '0');
    writeFileSync(counter2, '0');

    const t0 = Date.now();
    const results = await Promise.all([
      runWorker(['counter', ADDON, anchor1, counter1, '10', '10']),
      runWorker(['counter', ADDON, anchor2, counter2, '10', '10']),
    ]);
    const elapsed = Date.now() - t0;
    for (const r of results) expect(r.code).toBe(0);
    expect(readFileSync(counter1, 'utf8')).toBe('10');
    expect(readFileSync(counter2, 'utf8')).toBe('10');
    // 20 iters of ~10ms each, two anchors in parallel ≈ 100ms of work.
    // CI noise (spawn + scheduling) can add a few hundred ms; assert
    // total elapsed is well under the production retry budget (500 ms)
    // to catch a regression that adds cross-anchor waits.
    expect(elapsed).toBeLessThan(LOCK_MAX_ATTEMPTS * LOCK_RETRY_INTERVAL_MS);
  });
});
