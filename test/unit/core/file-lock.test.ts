// Unit tests for the generic interprocess file lock (Issue #106).
//
// The integration suite (test/integration/index-lock-kernel.test.ts)
// drives the kernel flock against the committed native addon with real
// child processes; here we exercise the same per-process invariants for
// the new acquireFileLock(lockPath) helper that the rest of the codebase
// builds on. Each test sets ENIGMA_HOME to a fresh temp dir so the lock
// anchor stays hermetic — the index-lock tests assert the same property
// for `indexLockPath()`; here we additionally exercise arbitrary anchor
// paths the new `acquireFileLock(lockPath)` API supports (e.g. the
// render-target locks at `<configDir>/locks/<sha256>.lock`).
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnigmaError } from '../../../src/core/errors.js';
import { __setLockTimingForTesting, LOCK_MAX_ATTEMPTS, LOCK_RETRY_INTERVAL_MS, acquireFileLock } from '../../../src/core/file-lock.js';
import { loadIndexLock } from '../../../src/core/native-lock.js';

describe('acquireFileLock — generic kernel-held interprocess lock (Issue #106)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  const originalTimings = { retryIntervalMs: LOCK_RETRY_INTERVAL_MS, maxAttempts: LOCK_MAX_ATTEMPTS };

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-filelock-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    __setLockTimingForTesting(originalTimings);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function anchor(name: string): string {
    // Returns an absolute lock anchor path WITHOUT creating the parent dir
    // or the file — each test asserts the property it cares about (creation,
    // reuse, peer contention, etc.).
    return join(tmpHome, 'locks', `${name}.lock`);
  }

  it('creates a 0600 anchor on first acquire and keeps the inode stable across release cycles', () => {
    const path = anchor('A');
    const lock = acquireFileLock(path);
    let modeDuringHold: number;
    try {
      expect(existsSync(path)).toBe(true);
      modeDuringHold = statSync(path).mode & 0o777;
    } finally {
      lock.release();
    }
    expect(modeDuringHold).toBe(0o600);
    const ino = statSync(path).ino;
    for (let i = 0; i < 5; i++) {
      const l = acquireFileLock(path);
      l.release();
    }
    expect(statSync(path).ino).toBe(ino);
  });

  it('writes pid + timestamp metadata while held; overwrites legacy/garbage body', () => {
    const path = anchor('META');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, 'deadbeef\nold-data\n', { mode: 0o600 });
    const lock = acquireFileLock(path);
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(2);
      expect(Number(lines[0])).toBe(process.pid);
      expect(Number.isFinite(Number(lines[1]))).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('throws E_LOCK_TIMEOUT naming the path when a live peer holds the anchor and never evicts', async () => {
    const path = anchor('PEER');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, '', { mode: 0o600 });
    const addon = loadIndexLock();
    const heldFd = openSync(path, 'r+');
    expect(addon.tryLockSync(heldFd)).toBe(true);
    const heldIno = statSync(path).ino;
    try {
      __setLockTimingForTesting({ retryIntervalMs: 5, maxAttempts: 3 });
      expect(() => acquireFileLock(path)).toThrowError(
        expect.objectContaining({ code: 'E_LOCK_TIMEOUT', message: expect.stringContaining(path) }),
      );
      // No eviction: inode and body unchanged on the held peer.
      expect(statSync(path).ino).toBe(heldIno);
    } finally {
      addon.unlockSync(heldFd);
      closeSync(heldFd);
    }
    // Peer released → next acquire succeeds immediately.
    const lock = acquireFileLock(path);
    lock.release();
  });

  it('two distinct anchors proceed in parallel within one retry budget (no cross-anchor wait)', () => {
    const path1 = anchor('ALPHA');
    const path2 = anchor('BETA');
    const start = Date.now();
    const lock1 = acquireFileLock(path1);
    const lock2 = acquireFileLock(path2);
    try {
      const elapsed = Date.now() - start;
      // One retry budget is ~500 ms in production (10 * 50). Acquire should
      // return immediately when anchors differ — give a generous bound to
      // absorb CI noise without waiting out the budget.
      expect(elapsed).toBeLessThan(LOCK_RETRY_INTERVAL_MS * LOCK_MAX_ATTEMPTS);
    } finally {
      lock2.release();
      lock1.release();
    }
  });

  it('creates the parent dir at 0700 when it does not exist (deeper than one level)', () => {
    const path = join(tmpHome, 'locks', 'deep', 'nested', 'anchor.lock');
    expect(existsSync(dirname(path))).toBe(false);
    const lock = acquireFileLock(path);
    try {
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(existsSync(path)).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('a pre-existing 0755 dir outside enigmaHome() is left alone (caller owns it, generic lock does not chmod)', () => {
    // Set up a caller-owned dir OUTSIDE tmpHome (= OUTSIDE enigmaHome())
    // with mode 0755. acquireFileLock must not tighten it — the caller
    // owns the dir, the lock helper only touches dirs inside the
    // Enigma config tree.
    const outsideHome = mkdtempSync(join(tmpdir(), 'enigma-filelock-outside-'));
    try {
      const callerDir = join(outsideHome, 'caller-owned');
      mkdirSync(callerDir, { recursive: true, mode: 0o755 });
      const path = join(callerDir, 'lockfile');
      const before = statSync(callerDir).mode & 0o777;
      expect(before).toBe(0o755);
      const lock = acquireFileLock(path);
      try {
        // Mode unchanged — we never chmod caller-owned dirs.
        expect(statSync(callerDir).mode & 0o777).toBe(0o755);
        expect(existsSync(path)).toBe(true);
      } finally {
        lock.release();
      }
    } finally {
      rmSync(outsideHome, { recursive: true, force: true });
    }
  });

  it('releases the lock in `finally` even when the held critical section throws', () => {
    const path = anchor('THROW');
    expect(() => {
      const lock = acquireFileLock(path);
      try {
        throw new Error('caller blew up');
      } finally {
        lock.release();
      }
    }).toThrowError(/caller blew up/);
    // A second acquire works immediately — kernel released the lock.
    const lock = acquireFileLock(path);
    lock.release();
  });

  it('wraps unexpected fs/native errors as E_LOCK_TIMEOUT naming the path', () => {
    const path = anchor('BAD');
    // Pre-create a directory in place of the anchor file so openSync('r+')
    // fails with EISDIR — an error the helper is not allowed to leak raw.
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
      expect(() => acquireFileLock(path)).toThrowError(
        expect.objectContaining({ code: 'E_LOCK_TIMEOUT', message: expect.stringContaining(path) }),
      );
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('exposes EnigmaError with the documented code on every failure path', () => {
    const path = anchor('CODE');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, '', { mode: 0o600 });
    const addon = loadIndexLock();
    const heldFd = openSync(path, 'r+');
    addon.tryLockSync(heldFd);
    try {
      __setLockTimingForTesting({ retryIntervalMs: 1, maxAttempts: 1 });
      try {
        acquireFileLock(path);
        expect.unreachable('expected timeout');
      } catch (err) {
        expect(err).toBeInstanceOf(EnigmaError);
        expect((err as EnigmaError).code).toBe('E_LOCK_TIMEOUT');
      }
    } finally {
      addon.unlockSync(heldFd);
      closeSync(heldFd);
    }
  });
});