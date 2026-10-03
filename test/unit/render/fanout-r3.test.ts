/* PR #124 fix batch r3 (Issue #108): fan-out is RECONCILIATION to the current index state. Under the NAME lock the
 * operation whose commit is current brings every holder to that state (set / strip); a superseded operation is
 * silent. Plus: `move` fans out AFTER its old-copy cleanup and never deletes a location a newer commit reused,
 * and plain `enigma render` reconciles removals against the CURRENT index. Deterministic hooks, FAKE stores only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setMoveCleanupHookForTesting, cmdMove } from '../../../src/cli/commands/move.js';
import { __setLockTimingForTesting, LOCK_MAX_ATTEMPTS, LOCK_RETRY_INTERVAL_MS, acquireFileLock } from '../../../src/core/file-lock.js';
import { mutateIndex, readIndex } from '../../../src/core/index-store.js';
import { __setFanoutGateForTesting, __setFanoutHooksForTesting, nameLockPath, reconcileAfterCommit } from '../../../src/render/fanout.js';
import { readLedger } from '../../../src/render/ledger.js';
import { buildRenderPlan, executeRender } from '../../../src/render/render.js';
import { commitImport } from '../../../src/storage/import-commit.js';
import { parseDotEnv } from '../../../src/storage/dotenv-file.js';
import { deleteSecret, resolveSecret, setSecret } from '../../../src/storage/manager.js';
import type { FakeStore, Sandbox } from './fanout-helpers.js';
import { block, installFakePromptingStore, makeRepo, makeSandbox, readEnv, seedTarget } from './fanout-helpers.js';

let sb: Sandbox;
let fake: FakeStore | undefined;
let priorCwd: string;
const timing = { interval: LOCK_RETRY_INTERVAL_MS, attempts: LOCK_MAX_ATTEMPTS };

beforeEach(() => {
  sb = makeSandbox();
  priorCwd = process.cwd();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.chdir(priorCwd);
  fake?.restore();
  fake = undefined;
  __setFanoutGateForTesting(undefined);
  __setFanoutHooksForTesting(undefined);
  __setMoveCleanupHookForTesting(undefined);
  __setLockTimingForTesting({ retryIntervalMs: timing.interval, maxAttempts: timing.attempts });
  vi.restoreAllMocks();
  sb.cleanup();
});

const add = (cwd: string, name: string, value: string, over: Record<string, unknown> = {}) =>
  setSecret({ name, value, scope: 'project', depository: 'encrypted', cwd, actor: 'cli', ...over });
const rotate = (cwd: string, name: string, value: string, over: Record<string, unknown> = {}) => add(cwd, name, value, { rotate: true, ...over });
const fileOf = (w: string): string => (existsSync(join(w, '.env')) ? readEnv(w) : '');
const lines = (content: string, name: string): string[] => content.split('\n').filter((l) => l.startsWith(`${name}=`));

function holdFirstFanOut(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  let first = true;
  __setFanoutGateForTesting(async () => {
    if (!first) return;
    first = false;
    reached();
    await hold;
  });
  return { reached: reachedP, release };
}

describe('item 1: a new prompting-store secret reconciles by stripping stale holders (QA H1)', () => {
  it('P1a: a NEW keychain secret commits between a delete strip\'s NAME-lock check and its target lock: the delete skips silently, the create strips', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    fake = installFakePromptingStore();
    await add(w!, 'TOKEN', 'v0');
    expect(fileOf(w!)).toBe(block('TOKEN=v0'));

    let created: { updatedAt: string; ref: string; depository: 'keychain' } | undefined;
    __setFanoutHooksForTesting({
      beforeTargetLock: () => {
        // The new secret's commit lands here: after the delete passed its NAME-lock check, before it takes the target lock.
        const stamp = new Date(Date.now() + 1000).toISOString();
        created = { updatedAt: stamp, ref: `${projectId}/TOKEN`, depository: 'keychain' };
        mutateIndex((idx) => ({
          ...idx,
          entries: [...idx.entries, { name: 'TOKEN', scope: 'project', projectId, projectPath: w!, depository: 'keychain', ref: created!.ref, createdAt: stamp, updatedAt: stamp }],
        }));
      },
    });
    const result = await deleteSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' });
    __setFanoutHooksForTesting(undefined);
    expect(result.warnings).toEqual([]); // superseded: silent
    expect(fileOf(w!)).toBe(block('TOKEN=v0')); // the delete did NOT strip: it is no longer current

    // The new secret's own fan-out (what setSecret runs right after its commit) reconciles: strips the stale holder.
    const warnings = await reconcileAfterCommit({ name: 'TOKEN', value: 'n', projectId, worktree: w!, depository: 'keychain', commit: created!, actor: 'cli', isNew: true, moved: false });
    expect(warnings).toEqual([]);
    expect(fileOf(w!)).toBe('');
    expect(readLedger().targets).toEqual([]);
  });

  it('a superseded rotate followed by a newer rotate is silent and every holder holds the newer value', async () => {
    const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
    await add(a!, 'API_KEY', 'v0');
    seedTarget(a!, projectId, block('API_KEY=v0'), ['API_KEY']);
    seedTarget(b!, projectId, block('API_KEY=v0'), ['API_KEY']);
    const gate = holdFirstFanOut();
    const first = rotate(a!, 'API_KEY', 'v1');
    await gate.reached;
    await rotate(b!, 'API_KEY', 'v2');
    gate.release();
    const result = await first;
    expect(result.warnings).toEqual([]);
    expect(fileOf(a!)).toBe(block('API_KEY=v2'));
    expect(fileOf(b!)).toBe(block('API_KEY=v2'));
  });
});

describe('item 2: move fans out AFTER old-store cleanup (review B2)', () => {
  it('sequential env -> encrypted from W: exactly one TOKEN= line in W, in the render block; another holder keeps its line', async () => {
    const { worktrees: [w, b], projectId } = makeRepo(sb, 1);
    await add(w!, 'TOKEN', 'v1', { depository: 'env' });
    expect(fileOf(w!)).toContain('# enigma:begin\nTOKEN=v1\n# enigma:end');
    seedTarget(b!, projectId, block('TOKEN=v1'), ['TOKEN']);
    process.chdir(w!);

    expect(await cmdMove(['TOKEN', '--to', 'encrypted', '--scope', 'project'])).toBe(0);

    const content = fileOf(w!);
    expect(lines(content, 'TOKEN')).toEqual(['TOKEN=v1']);
    expect(content).toContain('# enigma:render:begin\nTOKEN=v1\n# enigma:render:end');
    expect(readLedger().targets.find((t) => t.worktree === w)!.names).toEqual(['TOKEN']);
    expect(fileOf(b!)).toBe(block('TOKEN=v1'));
    await expect(resolveSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' })).resolves.toBe('v1');
  });

  it('sequential encrypted -> env from W: W has TOKEN only in its env block; another holder keeps its render line', async () => {
    const { worktrees: [w, b], projectId } = makeRepo(sb, 1);
    await add(w!, 'TOKEN', 'v1');
    seedTarget(b!, projectId, block('TOKEN=v1'), ['TOKEN']);
    process.chdir(w!);

    expect(await cmdMove(['TOKEN', '--to', 'env', '--scope', 'project'])).toBe(0);

    const content = fileOf(w!);
    expect(lines(content, 'TOKEN')).toEqual(['TOKEN=v1']);
    expect(content).not.toContain('enigma:render');
    expect(content).toContain('# enigma:begin\nTOKEN=v1\n# enigma:end');
    expect(fileOf(b!)).toBe(block('TOKEN=v1'));
  });
});

describe('item 3: move never deletes a location a newer commit reused (review B3)', () => {
  it('a delayed move -> env followed by a move -> encrypted: the encrypted value still resolves and is rendered', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    await add(w!, 'TOKEN', 'v1');
    process.chdir(w!);
    let nested: Promise<number> | undefined;
    __setMoveCleanupHookForTesting(async () => {
      __setMoveCleanupHookForTesting(undefined); // only the OUTER move is delayed
      // While move A (encrypted -> env) is between its commit and its cleanup, move B (env -> encrypted) runs to the end:
      // it re-creates encrypted's `<id>/TOKEN`, the very location A is about to delete.
      nested = cmdMove(['TOKEN', '--to', 'encrypted', '--scope', 'project']);
      await nested;
    });

    expect(await cmdMove(['TOKEN', '--to', 'env', '--scope', 'project'])).toBe(0);
    expect(await nested).toBe(0);

    await expect(resolveSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' })).resolves.toBe('v1');
    expect(lines(fileOf(w!), 'TOKEN')).toEqual(['TOKEN=v1']);
  });
});

describe('item 4: plain render reconciles removals against the CURRENT index (review B1)', () => {
  it('plan before NAME exists, a create fans out, the old plan executes: NAME is kept', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    const plan = buildRenderPlan({ cwd: w!, projectId, worktree: w!, index: readIndex(), manifest: { secrets: {} } });
    expect(plan.toResolve).toEqual([]);
    await add(w!, 'NEWNAME', 'v');
    expect(fileOf(w!)).toBe(block('NEWNAME=v'));

    const resolveValue = vi.fn(async () => 'x');
    const outcome = await executeRender(plan, { actor: 'cli', projectId, worktree: w!, resolveValue });

    expect(resolveValue).not.toHaveBeenCalled(); // a kept line is never re-resolved
    expect(fileOf(w!)).toBe(block('NEWNAME=v'));
    expect(outcome.kept).toEqual(['NEWNAME']);
    expect(outcome.removed).toEqual([]);
    expect(readLedger().targets[0]!.names).toEqual(['NEWNAME']);
  });

  it('the same with another planned name present: that one is rendered, NAME is kept', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    await add(w!, 'PLANNED', 'p', { depository: 'env' }); // env: its value lives in W's env block, not the render block
    const plan = buildRenderPlan({ cwd: w!, projectId, worktree: w!, index: readIndex(), manifest: { secrets: {} } });
    await add(w!, 'NEWNAME', 'v');

    const outcome = await executeRender(plan, { actor: 'cli', projectId, worktree: w!, resolveValue: async (name) => (name === 'PLANNED' ? 'p' : 'x') });

    expect(outcome.removed).toEqual([]);
    expect(lines(fileOf(w!), 'NEWNAME')).toEqual(['NEWNAME=v']);
    expect(readLedger().targets[0]!.names).toContain('NEWNAME');
  });

  it('a line whose name has NO current render-eligible entry is still removed (deleted, or only in a prompting store)', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    seedTarget(w!, projectId, block('GONE=old'), ['GONE']);
    fake = installFakePromptingStore();
    const plan = buildRenderPlan({ cwd: w!, projectId, worktree: w!, index: readIndex(), manifest: { secrets: {} } });
    const outcome = await executeRender(plan, { actor: 'cli', projectId, worktree: w!, resolveValue: async () => 'x' });
    expect(outcome.removed).toEqual(['GONE']);
    expect(fileOf(w!)).toBe('');
  });
});

describe('item 5/7: the NAME-lock timeout names the origin worktree; warnings point a prompting-store name at `enigma render NAME`', () => {
  it('a timed-out CREATE names its origin worktree (not yet a holder)', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    __setLockTimingForTesting({ retryIntervalMs: 1, maxAttempts: 2 });
    __setFanoutHooksForTesting({ nameLockRetries: 0 });
    const held = acquireFileLock(nameLockPath(projectId, 'API_KEY'));
    try {
      const result = await add(w!, 'API_KEY', 'v');
      expect(result.warnings.join('\n')).toContain(`render target ${w} was not updated for API_KEY (lock-timeout: its rendered copies of API_KEY may be stale; run \`enigma render\`)`);
    } finally {
      held.release();
    }
  });

  it('a timed-out keychain rotate tells the user `enigma render TOKEN` (plain render never renders a prompting store)', async () => {
    const { worktrees: [w, b], projectId } = makeRepo(sb, 1);
    fake = installFakePromptingStore();
    await add(w!, 'TOKEN', 'v0', { depository: 'keychain' });
    seedTarget(b!, projectId, block('TOKEN=v0'), ['TOKEN']);
    __setLockTimingForTesting({ retryIntervalMs: 1, maxAttempts: 2 });
    __setFanoutHooksForTesting({ nameLockRetries: 0 });
    const held = acquireFileLock(nameLockPath(projectId, 'TOKEN'));
    try {
      const result = await rotate(w!, 'TOKEN', 'v1', { depository: 'keychain' });
      expect(result.warnings.join('\n')).toContain(`render target ${b} was not updated for TOKEN (lock-timeout: its rendered copies of TOKEN may be stale; run \`enigma render TOKEN\`)`);
    } finally {
      held.release();
    }
  });

  it('an aborted keychain import says `enigma render NAME` per stored name', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    fake = installFakePromptingStore();
    await add(w!, 'LATER', 'exists-already');
    const source = join(w!, 'import.env');
    writeFileSync(source, 'KC_ONE=a\nLATER=x\n');
    const result = await commitImport({ entries: parseDotEnv('KC_ONE=a\nLATER=x\n').entries, depository: 'keychain', scope: 'project', cwd: w!, projectPath: w!, envFilePath: source, actor: 'cli' });
    expect(result.warnings.join('\n')).toContain('KC_ONE was stored but its rendered copies were not updated because the import did not complete; run `enigma render KC_ONE` once the issue is fixed.');
    expect(readFileSync(source, 'utf8')).toBe('KC_ONE=a\nLATER=x\n');
  });
});

describe('item 7: the render hint for a prompting-store name', () => {
  it('an explicit render superseded by a keychain rotate says `enigma render TOKEN again`; an encrypted name says `enigma render again`', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    fake = installFakePromptingStore();
    await add(w!, 'TOKEN', 'v1', { depository: 'keychain' });
    await add(w!, 'ENC', 'e1');
    const planTok = buildRenderPlan({ cwd: w!, projectId, worktree: w!, index: readIndex(), manifest: { secrets: {} }, explicitName: 'TOKEN' });
    const planEnc = buildRenderPlan({ cwd: w!, projectId, worktree: w!, index: readIndex(), manifest: { secrets: {} }, explicitName: 'ENC' });
    await rotate(w!, 'TOKEN', 'v2', { depository: 'keychain' });
    await rotate(w!, 'ENC', 'e2');
    const resolveValue = vi.fn(async () => 'x');
    const tok = await executeRender(planTok, { actor: 'cli', projectId, worktree: w!, resolveValue });
    const enc = await executeRender(planEnc, { actor: 'cli', projectId, worktree: w!, resolveValue });
    expect(tok.failed[0]!.reason).toBe('not written: changed concurrently; run enigma render TOKEN again');
    expect(enc.failed[0]!.reason).toBe('not written: changed concurrently; run enigma render again');
    expect(resolveValue).not.toHaveBeenCalled();
  });
});
