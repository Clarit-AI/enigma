// Issue #125: the per-secret operation lock (src/storage/op-lock.ts) serializes every change to one name —
// set / rotate / move / delete — across its whole write -> commit -> cleanup -> fan-out sequence.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setMoveCleanupHookForTesting, cmdMove } from '../../../src/cli/commands/move.js';
import { EnigmaError } from '../../../src/core/errors.js';
import { __setAsyncLockTimingForTesting, acquireFileLockAsync } from '../../../src/core/file-lock.js';
import { findIndexEntry, readIndex } from '../../../src/core/index-store.js';
import { auditLogPath, secretOpLockPath } from '../../../src/core/paths.js';
import { projectId } from '../../../src/core/project.js';
import { deleteSecret, resolveSecret, setSecret } from '../../../src/storage/manager.js';
import { opLockScopeId } from '../../../src/storage/op-lock.js';
import { makeRepo, makeSandbox } from '../render/fanout-helpers.js';
import type { Sandbox } from '../render/fanout-helpers.js';

const SENTINEL = 'sentinel-op-lock-value-7f3a';

let sb: Sandbox;
let priorCwd: string;
let out: string;

beforeEach(() => {
  sb = makeSandbox();
  priorCwd = process.cwd();
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => ((out += String(c)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => ((out += String(c)), true));
});

afterEach(() => {
  process.chdir(priorCwd);
  __setMoveCleanupHookForTesting(undefined);
  __setAsyncLockTimingForTesting({ timeoutMs: 30_000, retryIntervalMs: 25 });
  vi.restoreAllMocks();
  sb.cleanup();
});

const audit = (): string => (existsSync(auditLogPath()) ? readFileSync(auditLogPath(), 'utf8') : '');

describe('nested moves (Issue #125 repro 1, review r4 B1)', () => {
  it('a move started during another move\'s cleanup waits for it; the secret resolves where the index says', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    await setSecret({ name: 'TOKEN', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: w!, actor: 'cli' });
    process.chdir(w!);

    let nested: Promise<number> | undefined;
    let nestedDone = false;
    __setMoveCleanupHookForTesting(async () => {
      __setMoveCleanupHookForTesting(undefined); // only the OUTER move is delayed
      // Move B (env -> encrypted) would re-create encrypted's `<id>/TOKEN` — the very copy move A is about to
      // delete. Before the lock it ran to completion here and A then deleted B's value.
      nested = cmdMove(['TOKEN', '--to', 'encrypted', '--scope', 'project']).finally(() => (nestedDone = true));
      await new Promise((r) => setTimeout(r, 200));
      expect(nestedDone).toBe(false); // B is waiting for TOKEN's operation lock
    });

    expect(await cmdMove(['TOKEN', '--to', 'env', '--scope', 'project'])).toBe(0);
    expect(await nested).toBe(0);

    const entry = findIndexEntry(readIndex(), 'TOKEN', 'project', projectId(w!));
    expect(entry?.depository).toBe('encrypted');
    await expect(resolveSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' })).resolves.toBe(SENTINEL);
    expect(out).not.toContain(SENTINEL);
  });
});

describe('lock timeout', () => {
  async function holdLock(w: string, name: string) {
    return acquireFileLockAsync(secretOpLockPath(name, opLockScopeId('project', projectId(w))), 'test holder');
  }

  it('setSecret waits, then fails with E_LOCK_TIMEOUT naming the secret (never a value) and audits ok:false', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    const held = await holdLock(w!, 'TOKEN');
    __setAsyncLockTimingForTesting({ timeoutMs: 150, retryIntervalMs: 10 });
    try {
      const err = await setSecret({ name: 'TOKEN', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: w!, actor: 'cli' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_LOCK_TIMEOUT');
      expect((err as EnigmaError).message).toBe('another change to TOKEN is in progress; try again when it finishes');
    } finally {
      held.release();
    }
    expect(findIndexEntry(readIndex(), 'TOKEN', 'project', projectId(w!))).toBeUndefined(); // nothing was written
    const lines = audit().trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({ op: 'set', name: 'TOKEN', ok: false });
    expect(audit()).not.toContain(SENTINEL);
  });

  it('deleteSecret and move wait for the lock too', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    await setSecret({ name: 'TOKEN', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: w!, actor: 'cli' });
    const held = await holdLock(w!, 'TOKEN');
    __setAsyncLockTimingForTesting({ timeoutMs: 150, retryIntervalMs: 10 });
    process.chdir(w!);
    try {
      await expect(deleteSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' })).rejects.toMatchObject({ code: 'E_LOCK_TIMEOUT' });
      await expect(cmdMove(['TOKEN', '--to', 'env', '--scope', 'project'])).rejects.toMatchObject({ code: 'E_LOCK_TIMEOUT' });
    } finally {
      held.release();
    }
    // Untouched, and usable again once the holder is gone.
    await expect(resolveSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' })).resolves.toBe(SENTINEL);
    expect(await cmdMove(['TOKEN', '--to', 'env', '--scope', 'project'])).toBe(0);
    await expect(resolveSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('a different name, or the same name in another scope, does not wait', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    const held = await holdLock(w!, 'TOKEN');
    __setAsyncLockTimingForTesting({ timeoutMs: 150, retryIntervalMs: 10 });
    try {
      await setSecret({ name: 'OTHER', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: w!, actor: 'cli' });
      await setSecret({ name: 'TOKEN', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    } finally {
      held.release();
    }
  });
});
