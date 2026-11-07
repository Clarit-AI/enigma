// Issue #133: `enigma import` holds the operation lock of every entry's name for its whole batch (stores, the
// `.env` rewrite and the render fan-out), so a concurrent change to one of those names runs entirely before or
// entirely after the import. Before this, a rotate between an entry's commit and the batch's fan-out left the
// name with no `.env` line.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setAsyncLockTimingForTesting, acquireFileLockAsync } from '../../../src/core/file-lock.js';
import { readIndex } from '../../../src/core/index-store.js';
import { auditLogPath, secretOpLockPath } from '../../../src/core/paths.js';
import { projectId } from '../../../src/core/project.js';
import { parseDotEnv } from '../../../src/storage/dotenv-file.js';
import { commitImport } from '../../../src/storage/import-commit.js';
import { __setSecretBeforeCommitHookForTesting, resolveSecret, setSecret } from '../../../src/storage/manager.js';
import {
  OpLocksError,
  __setSecretOpLockBypassForTesting,
  acquireSecretOpLocks,
  opLockOrder,
  opLockScopeId,
} from '../../../src/storage/op-lock.js';
import { block, makeRepo, makeSandbox, readEnv } from '../render/fanout-helpers.js';
import type { Sandbox } from '../render/fanout-helpers.js';

let sb: Sandbox;

beforeEach(() => {
  sb = makeSandbox();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  __setSecretBeforeCommitHookForTesting(undefined);
  __setSecretOpLockBypassForTesting(false);
  __setAsyncLockTimingForTesting({ timeoutMs: 30_000, retryIntervalMs: 25 });
  vi.restoreAllMocks();
  sb.cleanup();
});

const importFile = (w: string, depository: 'encrypted' | 'env' = 'encrypted') =>
  commitImport({
    entries: parseDotEnv(readFileSync(join(w, '.env'), 'utf8')).entries,
    depository,
    scope: 'project',
    cwd: w,
    projectPath: w,
    envFilePath: join(w, '.env'),
    actor: 'cli',
  });

const scopeOf = (w: string): string => opLockScopeId('project', projectId(w));

/** True when nobody holds NAME's operation lock (a zero-budget acquire succeeds). */
async function isFree(name: string, scopeId: string): Promise<boolean> {
  try {
    (await acquireFileLockAsync(secretOpLockPath(name, scopeId), 'probe', { timeoutMs: 0 })).release();
    return true;
  } catch {
    return false;
  }
}

describe('import holds every entry\'s operation lock for the whole batch (Issue #133)', () => {
  it('a rotate of TOKEN started mid-import waits for the import, and TOKEN=new ends up rendered', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    writeFileSync(join(w!, '.env'), 'TOKEN=old\nOTHER=other\n');

    let rotate: Promise<unknown> | undefined;
    let rotateDone = false;
    let commits = 0;
    __setSecretBeforeCommitHookForTesting(async () => {
      if (++commits !== 2) return; // TOKEN has committed; OTHER is about to
      __setSecretBeforeCommitHookForTesting(undefined);
      rotate = setSecret({ name: 'TOKEN', value: 'new', scope: 'project', depository: 'encrypted', cwd: w!, actor: 'cli', rotate: true })
        .finally(() => (rotateDone = true));
      await new Promise((r) => setTimeout(r, 300));
      expect(rotateDone).toBe(false); // waiting on TOKEN's operation lock, held by the import
    });

    const result = await importFile(w!);
    expect(result.failed).toEqual([]);
    expect(result.succeeded).toEqual(['TOKEN', 'OTHER']);
    expect(rotate).toBeDefined();
    await rotate;

    await expect(resolveSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' })).resolves.toBe('new');
    // Before #133 the rotate ran inside the window, saw no holder, and the import then stripped TOKEN's raw line
    // and skipped its superseded fan-out: no TOKEN line at all.
    const env = readEnv(w!);
    expect(env.startsWith('# Moved to Enigma (encrypted) by `enigma import`')).toBe(true);
    expect(env.endsWith(block('TOKEN=new', 'OTHER=other'))).toBe(true);
    expect(env.match(/^TOKEN=/gm)).toEqual(['TOKEN=']); // exactly one TOKEN line, the rendered one
  });

  it('a held lock: the import stores nothing, returns (never throws) the blocked name, audits once, and releases the rest', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    // TOKEN is second: without the batch lock, OTHER would be stored before the import reached TOKEN.
    const original = 'OTHER=other\nTOKEN=old\nZETA=z\n';
    writeFileSync(join(w!, '.env'), original);
    __setAsyncLockTimingForTesting({ timeoutMs: 200, retryIntervalMs: 10 });
    const held = await acquireFileLockAsync(secretOpLockPath('TOKEN', scopeOf(w!)), 'test holder');

    let result;
    try {
      result = await importFile(w!);
    } finally {
      held.release();
    }

    expect(result.succeeded).toEqual([]);
    expect(result.failed).toEqual([
      { name: 'TOKEN', errorCode: 'E_LOCK_TIMEOUT', message: 'another change to TOKEN is in progress; try again when it finishes' },
    ]);
    expect(result.notAttempted).toEqual(['OTHER', 'ZETA']);
    expect(result.fileRewritten).toBe(false);
    expect(readFileSync(join(w!, '.env'), 'utf8')).toBe(original);
    expect(readIndex().entries).toEqual([]);

    const lines = existsSync(auditLogPath()) ? readFileSync(auditLogPath(), 'utf8').trim().split('\n') : [];
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ op: 'import', name: 'TOKEN', ok: false });
    expect(lines[0]).not.toContain('old');

    // OTHER sorts before TOKEN, so it was taken and must have been released; ZETA was never taken.
    expect(await isFree('OTHER', scopeOf(w!))).toBe(true);
    expect(await isFree('TOKEN', scopeOf(w!))).toBe(true);
    expect(await isFree('ZETA', scopeOf(w!))).toBe(true);
  });

  it('every lock is released after a successful import, and after one that aborts on a store failure', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    writeFileSync(join(w!, '.env'), 'A_ONE=1\nB_TWO=2\n');
    expect((await importFile(w!)).failed).toEqual([]);
    expect(await isFree('A_ONE', scopeOf(w!))).toBe(true);
    expect(await isFree('B_TWO', scopeOf(w!))).toBe(true);

    writeFileSync(join(w!, '.env'), 'C_THREE=3\nA_ONE=again\n'); // A_ONE exists: E_EXISTS aborts the batch
    const aborted = await importFile(w!);
    expect(aborted.failed.map((f) => f.errorCode)).toEqual(['E_EXISTS']);
    expect(await isFree('A_ONE', scopeOf(w!))).toBe(true);
    expect(await isFree('C_THREE', scopeOf(w!))).toBe(true);
  });
});

describe('acquireSecretOpLocks', () => {
  it('opLockOrder dedupes and sorts by code unit', () => {
    expect(opLockOrder(['ZETA', 'A_1', 'ZETA', 'B', 'A_0'])).toEqual(['A_0', 'A_1', 'B', 'ZETA']);
  });

  it('holds every lock until release(); a second release() is a no-op', async () => {
    const locks = await acquireSecretOpLocks(['B', 'A', 'B'], 'global');
    expect(await isFree('A', 'global')).toBe(false);
    expect(await isFree('B', 'global')).toBe(false);
    locks.release();
    locks.release();
    expect(await isFree('A', 'global')).toBe(true);
    expect(await isFree('B', 'global')).toBe(true);
  });

  it('one deadline for the whole batch, not one per name', async () => {
    // A is held for 400 ms of a 600 ms budget, C for longer. With one shared deadline the batch gives up about
    // 600 ms in; with a fresh budget per name it would wait 400 ms for A and then a full 600 ms for C (~1000 ms).
    __setAsyncLockTimingForTesting({ timeoutMs: 600, retryIntervalMs: 10 });
    const heldA = await acquireFileLockAsync(secretOpLockPath('A', 'global'), 'test holder');
    const heldC = await acquireFileLockAsync(secretOpLockPath('C', 'global'), 'test holder');
    const releaseA = setTimeout(() => heldA.release(), 400);
    const start = Date.now();
    let err: unknown;
    try {
      err = await acquireSecretOpLocks(['A', 'B', 'C'], 'global').catch((e: unknown) => e);
    } finally {
      clearTimeout(releaseA);
      heldA.release();
      heldC.release();
    }
    const elapsed = Date.now() - start;
    expect((err as OpLocksError).secretName).toBe('C');
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(850);
  });

  it('a failure names the blocked secret and releases the locks already taken', async () => {
    __setAsyncLockTimingForTesting({ timeoutMs: 100, retryIntervalMs: 10 });
    const held = await acquireFileLockAsync(secretOpLockPath('B', 'global'), 'test holder');
    try {
      const err = await acquireSecretOpLocks(['A', 'B', 'C'], 'global').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpLocksError);
      expect((err as OpLocksError).secretName).toBe('B');
      expect((err as OpLocksError).cause).toMatchObject({ code: 'E_LOCK_TIMEOUT', secretName: 'B' });
    } finally {
      held.release();
    }
    expect(await isFree('A', 'global')).toBe(true);
  });

  it('honors the test-only bypass', async () => {
    __setSecretOpLockBypassForTesting(true);
    const locks = await acquireSecretOpLocks(['A'], 'global');
    expect(await isFree('A', 'global')).toBe(true);
    locks.release();
  });
});
