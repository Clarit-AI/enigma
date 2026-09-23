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
import { indexLockPath } from '../../src/core/paths.js';

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
      child.kill('SIGKILL');
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
