/* PR #124 fix batch r1 (Issue #108): the two rules that close every "newer operation does not write what the
 * guard assumed it would" gap, and a pin for each of the batch's items. Deterministic: gates and hooks, no sleeps.
 *
 *   Rule A: never write a superseded value. Under the target's file lock, immediately before a NAME line is
 *           written, the writer's commit identity is compared with the index; a stale value is not written.
 *   Rule B: fan-outs for one NAME are serialized by a per-NAME lock, always taken before any target lock.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdMove } from '../../../src/cli/commands/move.js';
import { __setLockTimingForTesting, LOCK_MAX_ATTEMPTS, LOCK_RETRY_INTERVAL_MS, acquireFileLock } from '../../../src/core/file-lock.js';
import { mutateIndex, readIndex } from '../../../src/core/index-store.js';
import { renderLockPath } from '../../../src/core/paths.js';
import { __setFanoutGateForTesting, __setFanoutHooksForTesting, nameLockPath } from '../../../src/render/fanout.js';
import { readLedger } from '../../../src/render/ledger.js';
import { buildRenderPlan, executeRender } from '../../../src/render/render.js';
import { deleteSecret, listSecrets, setSecret } from '../../../src/storage/manager.js';
import { commitImport } from '../../../src/storage/import-commit.js';
import { parseDotEnv } from '../../../src/storage/dotenv-file.js';
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
  __setLockTimingForTesting({ retryIntervalMs: timing.interval, maxAttempts: timing.attempts });
  vi.restoreAllMocks();
  sb.cleanup();
});

const add = (cwd: string, name: string, value: string, over: Record<string, unknown> = {}) =>
  setSecret({ name, value, scope: 'project', depository: 'encrypted', cwd, actor: 'cli', ...over });
const rotate = (cwd: string, name: string, value: string, over: Record<string, unknown> = {}) => add(cwd, name, value, { rotate: true, ...over });

/** Hold the FIRST fan-out at its gate (after its commit, before its lock); everything after passes straight through. */
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

describe('item 1: move writes its value (QA H1)', () => {
  it('rotate R1 committed, then move --to env, R1 fan-out released last: every holder ends with the current value', async () => {
    const { worktrees: [w, b], projectId } = makeRepo(sb, 1);
    await add(w!, 'API_KEY', 'v0');
    seedTarget(w!, projectId, block('API_KEY=v0'), ['API_KEY']);
    seedTarget(b!, projectId, `# b\n${block('API_KEY=v0', 'OTHER=o')}`, ['API_KEY', 'OTHER']);

    const gate = holdFirstFanOut();
    const r1 = rotate(w!, 'API_KEY', 'v1');
    await gate.reached;
    process.chdir(w!);
    expect(await cmdMove(['API_KEY', '--to', 'env', '--scope', 'project'])).toBe(0);
    gate.release();
    await r1;

    expect(readEnv(b!)).toBe(`# b\n${block('API_KEY=v1', 'OTHER=o')}`);
    // W now holds NAME in its env block, so its render line is gone and there is exactly one definition.
    const wFile = readEnv(w!);
    expect(wFile).not.toContain('enigma:render');
    expect(wFile.match(/^API_KEY=/gm)).toEqual(['API_KEY=']);
    expect(wFile).toContain('API_KEY=v1');
  });

  it('rotate R1 committed, then move --to encrypted from a prompting store, R1 fan-out released last: no holder is stale', async () => {
    const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
    fake = installFakePromptingStore();
    await add(a!, 'TOKEN', 'v0', { depository: 'keychain' });
    seedTarget(a!, projectId, block('TOKEN=v0'), ['TOKEN']);
    seedTarget(b!, projectId, block('TOKEN=v0'), ['TOKEN']);

    const gate = holdFirstFanOut();
    const r1 = rotate(a!, 'TOKEN', 'v1', { depository: 'keychain' });
    await gate.reached;
    process.chdir(a!);
    expect(await cmdMove(['TOKEN', '--to', 'encrypted', '--scope', 'project'])).toBe(0);
    gate.release();
    await r1;

    expect(readEnv(a!)).toBe(block('TOKEN=v1'));
    expect(readEnv(b!)).toBe(block('TOKEN=v1'));
  });
});

describe('item 2: plain `enigma render` never writes a superseded value (Rule A in executeRender)', () => {
  it('resolves the old value, a rotate commits and fans out, then the render writes: the target keeps the NEW value', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    await add(w!, 'API_KEY', 'v1');
    expect(readEnv(w!)).toBe(block('API_KEY=v1'));

    const plan = buildRenderPlan({ cwd: w!, projectId, worktree: w!, index: readIndex(), manifest: { secrets: {} } });
    const outcome = await executeRender(plan, {
      actor: 'cli',
      projectId,
      worktree: w!,
      resolveValue: async () => {
        const stale = 'v1';
        await rotate(w!, 'API_KEY', 'v2');
        return stale;
      },
    });

    expect(readEnv(w!)).toBe(block('API_KEY=v2'));
    expect(outcome.rendered).toEqual([]);
    expect(outcome.failed).toEqual([
      expect.objectContaining({ name: 'API_KEY', errorCode: 'E_SUPERSEDED', reason: 'not written: changed concurrently; run enigma render again', keptPreviousLine: true }),
    ]);
    expect(readLedger().targets[0]!.names).toEqual(['API_KEY']);
  });

  it('with no existing line the name stays absent (fail closed) and is reported', async () => {
    const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
    await add(a!, 'API_KEY', 'v1'); // only A is a holder
    const plan = buildRenderPlan({ cwd: b!, projectId, worktree: b!, index: readIndex(), manifest: { secrets: {} } });
    const outcome = await executeRender(plan, {
      actor: 'cli',
      projectId,
      worktree: b!,
      resolveValue: async () => {
        await rotate(a!, 'API_KEY', 'v2');
        return 'v1';
      },
    });
    expect(existsSync(join(b!, '.env'))).toBe(false);
    expect(outcome.failed).toEqual([expect.objectContaining({ name: 'API_KEY', errorCode: 'E_SUPERSEDED', keptPreviousLine: false })]);
  });
});

describe('item 3: create vs rotate (Rule B)', () => {
  it('a create whose fan-out is released AFTER a rotate committed never leaves its old value: current value, or absent with a report', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    const gate = holdFirstFanOut();
    const create = add(w!, 'API_KEY', 'v1');
    await gate.reached;
    await rotate(w!, 'API_KEY', 'v2');
    gate.release();
    const result = await create;

    const file = existsSync(join(w!, '.env')) ? readEnv(w!) : '';
    expect(file).not.toContain('API_KEY=v1');
    if (!file.includes('API_KEY=v2')) expect(result.warnings.join('\n')).toContain('changed concurrently; run `enigma render` again');
  });
});

describe('item 4: import fan-out is deferred until the batch commits', () => {
  it('a batch that aborts leaves the file byte-identical, renders nothing, and says the stored names were not rendered', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    const original = 'FIRST=one\nSECOND=two\n';
    writeFileSync(join(w!, '.env'), original);
    await add(w!, 'SECOND', 'already-here'); // the second entry will fail with E_EXISTS
    const entries = parseDotEnv(original).entries;
    // `add` just rendered SECOND into the file: put the original content back so the file is the import source.
    writeFileSync(join(w!, '.env'), original);
    rmSync(join(sb.home, 'render-ledger.json'), { force: true });

    const result = await commitImport({ entries, depository: 'encrypted', scope: 'project', cwd: w!, projectPath: w!, envFilePath: join(w!, '.env'), actor: 'cli' });

    expect(result.failed.map((f) => f.name)).toEqual(['SECOND']);
    expect(readEnv(w!)).toBe(original);
    expect(readLedger().targets).toEqual([]);
    expect(result.warnings.join('\n')).toContain('FIRST was stored but not rendered into this worktree\'s render block because the import did not complete; run `enigma render` once the issue is fixed.');
  });

  it('a batch that commits renders every stored name once the plaintext rewrite is done', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    writeFileSync(join(w!, '.env'), 'FIRST=one\nSECOND=two\n');
    const entries = parseDotEnv(readFileSync(join(w!, '.env'), 'utf8')).entries;
    const result = await commitImport({ entries, depository: 'encrypted', scope: 'project', cwd: w!, projectPath: w!, envFilePath: join(w!, '.env'), actor: 'cli' });
    expect(result.failed).toEqual([]);
    expect(readEnv(w!)).toContain(block('FIRST=one', 'SECOND=two'));
    expect(readLedger().targets[0]!.names).toEqual(['FIRST', 'SECOND']);
  });
});

describe('item 5: a NEW prompting-store secret never fans out', () => {
  it('a stale holder (kept by a render-disabled skip during a delete) is left alone when TOKEN is re-created in a prompting store', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    await add(w!, 'TOKEN', 'old');
    expect(readEnv(w!)).toBe(block('TOKEN=old'));
    writeFileSync(join(w!, '.enigma.json'), JSON.stringify({ secrets: {}, render: { enabled: false } }));
    await deleteSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' });
    expect(readEnv(w!)).toBe(block('TOKEN=old')); // disabled skip: the stale line and its row survive
    rmSync(join(w!, '.enigma.json'));
    fake = installFakePromptingStore();

    await add(w!, 'TOKEN', 'brand-new', { depository: 'keychain' });

    expect(readEnv(w!)).toBe(block('TOKEN=old'));
    expect(listSecrets({ scope: 'project', cwd: w! })[0]!.depository).toBe('keychain');
  });
});

describe('item 6: the locking mechanism is pinned (each test fails if its rule is removed)', () => {
  /** Simulate a newer commit landing: same entry, later `updatedAt`. */
  const commitNewer = (name: string): void =>
    mutateIndex((idx) => ({ ...idx, entries: idx.entries.map((e) => (e.name === name ? { ...e, updatedAt: new Date(Date.parse(e.updatedAt) + 5000).toISOString() } : e)) }));

  it('(a) the Rule A identity check runs INSIDE the per-file lock hold: a commit that lands right before the lock is taken is still seen', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    await add(w!, 'API_KEY', 'v0');
    seedTarget(w!, projectId, block('API_KEY=v0'), ['API_KEY']);
    let fired = 0;
    __setFanoutHooksForTesting({
      beforeTargetLock: () => {
        fired++;
        commitNewer('API_KEY');
      },
    });

    await rotate(w!, 'API_KEY', 'v1');

    expect(fired).toBeGreaterThan(0);
    expect(readEnv(w!)).toBe(block('API_KEY=v0')); // v1 is superseded by the newer commit: never written
  });

  it('(b) the per-file lock is really held while a target is written (a second taker times out)', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    await add(w!, 'API_KEY', 'v0');
    seedTarget(w!, projectId, block('API_KEY=v0'), ['API_KEY']);
    const outcomes: string[] = [];
    __setLockTimingForTesting({ retryIntervalMs: 1, maxAttempts: 2 });
    __setFanoutHooksForTesting({
      afterTargetLock: (file) => {
        try {
          acquireFileLock(renderLockPath(file)).release();
          outcomes.push('acquired');
        } catch (err) {
          outcomes.push((err as { code?: string }).code ?? 'other');
        }
      },
    });

    await rotate(w!, 'API_KEY', 'v1');

    expect(outcomes).toEqual(['E_LOCK_TIMEOUT']);
    expect(readEnv(w!)).toBe(block('API_KEY=v1'));
  });

  it('(c) the per-NAME lock (Rule B) is really held for the whole fan-out (a second taker times out)', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    await add(w!, 'API_KEY', 'v0');
    seedTarget(w!, projectId, block('API_KEY=v0'), ['API_KEY']);
    const outcomes: string[] = [];
    __setLockTimingForTesting({ retryIntervalMs: 1, maxAttempts: 2 });
    const tryName = (): void => {
      try {
        acquireFileLock(nameLockPath(projectId, 'API_KEY')).release();
        outcomes.push('acquired');
      } catch (err) {
        outcomes.push((err as { code?: string }).code ?? 'other');
      }
    };
    __setFanoutHooksForTesting({ afterNameLock: tryName, afterTargetLock: tryName });

    await rotate(w!, 'API_KEY', 'v1');

    // Once when the NAME lock is first held, once more while a target is being written: both still blocked.
    expect(outcomes).toEqual(['E_LOCK_TIMEOUT', 'E_LOCK_TIMEOUT']);
  });

  it('the NAME lock is taken before any target lock (afterNameLock fires before beforeTargetLock)', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    await add(w!, 'API_KEY', 'v0');
    seedTarget(w!, projectId, block('API_KEY=v0'), ['API_KEY']);
    const order: string[] = [];
    __setFanoutHooksForTesting({ afterNameLock: () => order.push('name'), beforeTargetLock: () => order.push('target') });
    await rotate(w!, 'API_KEY', 'v1');
    expect(order).toEqual(['name', 'target']);
  });
});
