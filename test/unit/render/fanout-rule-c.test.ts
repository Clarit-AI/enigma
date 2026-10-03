/* PR #124 fix batch r2 (Issue #108): Rule C — every operation carries the identity it acted on, captured once
 * (at commit for a fan-out, at PLAN time for a plain render), and writes or strips only while the index still
 * says exactly that. Plus the shared fan-out policy, `enigma move` warnings and import's left-in-place names.
 * Deterministic: gates and hooks, no sleeps.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdMove } from '../../../src/cli/commands/move.js';
import { readIndex } from '../../../src/core/index-store.js';
import { __setFanoutGateForTesting, __setFanoutHooksForTesting } from '../../../src/render/fanout.js';
import { readLedger } from '../../../src/render/ledger.js';
import { buildRenderPlan, executeRender } from '../../../src/render/render.js';
import { commitImport } from '../../../src/storage/import-commit.js';
import { parseDotEnv } from '../../../src/storage/dotenv-file.js';
import { deleteSecret, setSecret } from '../../../src/storage/manager.js';
import type { FakeStore, Sandbox } from './fanout-helpers.js';
import { block, installFakePromptingStore, makeRepo, makeSandbox, readEnv, seedTarget } from './fanout-helpers.js';

let sb: Sandbox;
let fake: FakeStore | undefined;
let priorCwd: string;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sb = makeSandbox();
  priorCwd = process.cwd();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.chdir(priorCwd);
  fake?.restore();
  fake = undefined;
  __setFanoutGateForTesting(undefined);
  __setFanoutHooksForTesting(undefined);
  vi.restoreAllMocks();
  sb.cleanup();
});

const errText = (): string => stderr.mock.calls.map((c: unknown[]) => String(c[0])).join('');
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

describe('strips carry identity (review B1)', () => {
  it('(a) a delayed move-to-keychain strip released after a LATER keychain rotate wrote TOKEN=newest keeps newest', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    fake = installFakePromptingStore();
    await add(w!, 'TOKEN', 'v0');
    expect(readEnv(w!)).toBe(block('TOKEN=v0'));

    const gate = holdFirstFanOut();
    process.chdir(w!);
    const moving = cmdMove(['TOKEN', '--to', 'keychain', '--scope', 'project']);
    await gate.reached; // the move has committed; its strip has not run
    await rotate(w!, 'TOKEN', 'newest', { depository: 'keychain' }); // writes TOKEN=newest into the holder
    expect(readEnv(w!)).toBe(block('TOKEN=newest'));
    gate.release();
    await moving;

    expect(readEnv(w!)).toBe(block('TOKEN=newest'));
    expect(readLedger().targets[0]!.names).toEqual(['TOKEN']);
    expect(errText()).toContain('changed concurrently; run `enigma render` again');
  });

  it('(b) a delayed delete strip released after a new keychain create plus rotate keeps the new value', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    fake = installFakePromptingStore();
    await add(w!, 'TOKEN', 'v0');

    const gate = holdFirstFanOut();
    const deleting = deleteSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' });
    await gate.reached; // the delete has committed; its strip has not run
    await add(w!, 'TOKEN', 'created', { depository: 'keychain' }); // new prompting secret: no fan-out
    await rotate(w!, 'TOKEN', 'newest', { depository: 'keychain' }); // updates the holder
    expect(readEnv(w!)).toBe(block('TOKEN=newest'));
    gate.release();
    const result = await deleting;

    expect(readEnv(w!)).toBe(block('TOKEN=newest'));
    expect(result.warnings).toEqual(['render fan-out skipped for TOKEN (changed concurrently; run `enigma render` again)']);
  });
});

describe('plain render binds to the PLANNED entry (review B4)', () => {
  it('plan, then move to the keychain, then execute: nothing is resolved (no prompt), rendered=[], E_SUPERSEDED', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    fake = installFakePromptingStore();
    await add(w!, 'API_KEY', 'v1');
    const plan = buildRenderPlan({ cwd: w!, projectId, worktree: w!, index: readIndex(), manifest: { secrets: {} } });
    expect(plan.toResolve.map((t) => t.name)).toEqual(['API_KEY']);

    process.chdir(w!);
    expect(await cmdMove(['API_KEY', '--to', 'keychain', '--scope', 'project'])).toBe(0);
    const resolveValue = vi.fn(async () => 'must-never-be-asked-for');
    const outcome = await executeRender(plan, { actor: 'cli', projectId, worktree: w!, resolveValue });

    expect(resolveValue).not.toHaveBeenCalled();
    expect(fake.resolveCalls).toEqual([]);
    expect(outcome.rendered).toEqual([]);
    expect(outcome.failed).toEqual([expect.objectContaining({ name: 'API_KEY', errorCode: 'E_SUPERSEDED', keptPreviousLine: false })]);
    expect(existsSync(join(w!, '.env')) ? readEnv(w!) : '').not.toContain('must-never-be-asked-for');
  });
});

describe('one fan-out policy for setSecret AND import (Kilo critical, review B3/B5)', () => {
  it('import --depository keychain of a NEW name leaves a stale holder unchanged', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    await add(w!, 'TOKEN', 'old');
    writeFileSync(join(w!, '.enigma.json'), JSON.stringify({ secrets: {}, render: { enabled: false } }));
    await deleteSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' }); // disabled skip: stale holder survives
    rmSync(join(w!, '.enigma.json'));
    expect(readEnv(w!)).toBe(block('TOKEN=old'));
    fake = installFakePromptingStore();
    const source = join(w!, 'import.env');
    writeFileSync(source, 'TOKEN=imported\n');

    const result = await commitImport({ entries: parseDotEnv('TOKEN=imported\n').entries, depository: 'keychain', scope: 'project', cwd: w!, projectPath: w!, envFilePath: source, actor: 'cli' });

    expect(result.failed).toEqual([]);
    expect(readEnv(w!)).toBe(block('TOKEN=old'));
    expect(fake.resolveCalls).toEqual([]);
  });

  it('an aborted env import with another worktree holding the name still says the stored name was not rendered', async () => {
    const { worktrees: [w, b], projectId } = makeRepo(sb, 1);
    await add(w!, 'LATER', 'exists-already');
    seedTarget(b!, projectId, block('API_KEY=old'), ['API_KEY']);
    const source = join(w!, 'import.env');
    writeFileSync(source, 'API_KEY=new\nLATER=x\n');

    const result = await commitImport({ entries: parseDotEnv('API_KEY=new\nLATER=x\n').entries, depository: 'env', scope: 'project', cwd: w!, projectPath: w!, envFilePath: source, actor: 'cli' });

    expect(result.failed.map((f) => f.name)).toEqual(['LATER']);
    expect(result.warnings.join('\n')).toContain('API_KEY was stored but its rendered copies were not updated because the import did not complete; run `enigma render` once the issue is fixed.');
    expect(readEnv(b!)).toBe(block('API_KEY=old'));
  });
});

describe('enigma move prints fan-out warnings (QA M1)', () => {
  it('a damaged holder during a move shows up on stderr', async () => {
    const { worktrees: [w, b], projectId } = makeRepo(sb, 1);
    await add(w!, 'API_KEY', 'v1');
    seedTarget(b!, projectId, '# enigma:render:begin\nAPI_KEY=v1\n', ['API_KEY']); // damaged: no end marker
    process.chdir(w!);

    expect(await cmdMove(['API_KEY', '--to', 'env', '--scope', 'project'])).toBe(0);

    expect(errText()).toContain(`warning: render target ${b} was not updated for API_KEY (damaged-render-block)`);
  });
});

describe('import does not fan out a name it left in place (QA M2)', () => {
  it('a plaintext line edited before the rewrite stays the only definition: no render block, no ledger row', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    const envFilePath = join(w!, '.env');
    writeFileSync(envFilePath, 'A=edited-on-disk\n');

    const result = await commitImport({ entries: parseDotEnv('A=original\n').entries, depository: 'encrypted', scope: 'project', cwd: w!, projectPath: w!, envFilePath, actor: 'cli' });

    expect(result.skippedMismatch).toEqual(['A']);
    expect(readFileSync(envFilePath, 'utf8')).toBe('A=edited-on-disk\n');
    expect(readLedger().targets).toEqual([]);
  });
});
