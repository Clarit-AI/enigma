// Real-process evidence for Issue #108 AC 8: "concurrent rotates of NAME from two worktrees → each
// target ends with the value of whichever rotate committed last in the index; no torn file".
//
// Fan-out runs after the index commit and outside the index lock, so two rotates can fan out in
// either order. The ordering test below forces the harmful one: the FIRST commit's fan-out runs
// after the SECOND commit has fully fanned out. It fails on any implementation that does not
// compare the commit against the index under each target's lock (the stale v1 would overwrite v2).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readLedger } from '../../src/render/ledger.js';
import { parseDotEnv } from '../../src/storage/dotenv-file.js';
import { readIndex } from '../../src/core/index-store.js';
import { resolveSecret, setSecret } from '../../src/storage/manager.js';
import { block, makeRepo, makeSandbox, readEnv, seedTarget } from '../unit/render/fanout-helpers.js';
import type { Sandbox } from '../unit/render/fanout-helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = resolve(here, '..', '..', 'plugins', 'enigma', 'native');
let bundleDir: string;
let workerPath: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'enigma-fanout-worker-'));
  workerPath = join(bundleDir, 'fanout-worker.mjs');
  await build({
    entryPoints: [resolve(here, 'fanout-worker.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });
});

afterAll(async () => {
  const { rmSync } = await import('node:fs');
  rmSync(bundleDir, { recursive: true, force: true });
});

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

interface Worker {
  committed: Promise<string>;
  exit: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function spawnWorker(cwd: string, name: string, value: string, gate?: { goFile: string; signalFile: string }, extraEnv: Record<string, string> = {}): Worker {
  const args = [workerPath, cwd, name, value, ...(gate ? [gate.goFile, gate.signalFile] : [])];
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ENIGMA_HOME: process.env.ENIGMA_HOME!, ENIGMA_NATIVE_DIR: NATIVE_DIR, ...extraEnv },
  });
  let stdout = '';
  let stderr = '';
  let onCommit!: (updatedAt: string) => void;
  const committed = new Promise<string>((res) => (onCommit = res));
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    const m = stdout.match(/COMMIT (\S*)/);
    if (m) onCommit(m[1]!);
  });
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>((res) => child.on('exit', (code) => res({ code, stdout, stderr })));
  return { committed, exit };
}

async function waitFor(path: string, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const valueLines = (worktree: string): string[] => readEnv(worktree).split('\n').filter((l) => l.startsWith('API_KEY='));

describe('render fan-out under concurrent rotates — real processes (Issue #108 AC 8)', () => {
  it('a rotate whose fan-out runs AFTER a newer commit fanned out does not overwrite it', async () => {
    const { worktrees: [a, b, c], projectId } = makeRepo(sb, 2);
    await setSecret({ name: 'API_KEY', value: 'v0', scope: 'project', depository: 'encrypted', cwd: a!, actor: 'cli' });
    seedTarget(a!, projectId, block('API_KEY=v0'), ['API_KEY']);
    seedTarget(b!, projectId, `# keep\n${block('API_KEY=v0', 'OTHER=o')}`, ['API_KEY', 'OTHER']);
    seedTarget(c!, projectId, block('API_KEY=v0'), ['API_KEY']);

    const goFile = join(bundleDir, 'go-1');
    const signalFile = join(bundleDir, 'signal-1');
    // First rotate (from B) commits v1, then is held before its fan-out.
    const first = spawnWorker(b!, 'API_KEY', 'v1', { goFile, signalFile });
    await waitFor(signalFile);
    // Second rotate (from C) commits v2 AFTER v1 and fans out completely.
    const second = spawnWorker(c!, 'API_KEY', 'v2');
    const secondExit = await second.exit;
    expect(secondExit.code, secondExit.stderr).toBe(0);
    for (const w of [a!, b!, c!]) expect(valueLines(w)).toEqual(['API_KEY=v2']);

    // Now the stale v1 fan-out is released.
    writeFileSync(goFile, 'go');
    const firstExit = await first.exit;
    expect(firstExit.code, firstExit.stderr).toBe(0);

    for (const w of [a!, b!, c!]) expect(valueLines(w)).toEqual(['API_KEY=v2']);
    expect(readEnv(b!)).toBe(`# keep\n${block('API_KEY=v2', 'OTHER=o')}`);
    await expect(resolveSecret('API_KEY', { scope: 'project', cwd: a!, actor: 'cli' })).resolves.toBe('v2');
    expect(readLedger().targets.map((t) => t.names.join(',')).sort()).toEqual(['API_KEY', 'API_KEY', 'API_KEY,OTHER']);
  }, 60_000);

  it('rotates fanning out concurrently from three worktrees: every target ends with the last COMMITTED value, never torn', async () => {
    const { worktrees: [a, b, c], projectId } = makeRepo(sb, 2);
    await setSecret({ name: 'API_KEY', value: 'v0', scope: 'project', depository: 'encrypted', cwd: a!, actor: 'cli' });
    for (const w of [a!, b!, c!]) seedTarget(w, projectId, `PRE=1\n${block('API_KEY=v0', 'KEEP=k')}POST=2\n`, ['API_KEY', 'KEEP']);

    // Commit sequentially (the encrypted vault's own write is not what this test is about), but release
    // all three fan-outs together so they contend for the per-file locks in an arbitrary order.
    const goFile = join(bundleDir, 'go-all');
    const workers: Array<{ w: Worker; value: string }> = [];
    for (const [i, cwd] of [a!, b!, c!].entries()) {
      const signalFile = join(bundleDir, `signal-all-${i}`);
      const w = spawnWorker(cwd, 'API_KEY', `v${i + 1}`, { goFile, signalFile });
      await waitFor(signalFile);
      workers.push({ w, value: `v${i + 1}` });
    }
    writeFileSync(goFile, 'go');
    const exits = await Promise.all(workers.map((x) => x.w.exit));
    for (const e of exits) expect(e.code, e.stderr).toBe(0);

    const committedLast = readIndex().entries.find((e) => e.name === 'API_KEY')!;
    const stamps = await Promise.all(workers.map((x) => x.w.committed));
    const winner = workers[stamps.indexOf(committedLast.updatedAt)]!.value;
    expect(winner).toBe('v3');
    for (const w of [a!, b!, c!]) {
      expect(readEnv(w)).toBe(`PRE=1\n${block(`API_KEY=${winner}`, 'KEEP=k')}POST=2\n`);
      expect(parseDotEnv(readEnv(w)).entries.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('create vs rotate (Rule B): a rotate that commits while a create is mid-fan-out waits for it, then writes the current value to the target the create just added', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    const goFile = join(bundleDir, 'go-create');
    const signalFile = join(bundleDir, 'signal-create');

    // The create commits v1, takes the NAME lock, passes its guard for W, and is held right there.
    const create = spawnWorker(w!, 'API_KEY', 'v1', undefined, { FANOUT_CREATE: '1', FANOUT_HOLD_AFTER_GUARD: `${goFile}:${signalFile}` });
    await waitFor(signalFile);

    // A rotate now commits v2. Its fan-out must not snapshot holders until the create's fan-out is done: it
    // either exits (no per-NAME lock: it snapshotted a ledger that does not list W yet) or is still waiting.
    const rotate = spawnWorker(w!, 'API_KEY', 'v2');
    await rotate.committed;
    const early = await Promise.race([rotate.exit.then(() => 'exited'), new Promise((r) => setTimeout(() => r('waiting'), 1500))]);
    writeFileSync(goFile, 'go');

    const [createExit, rotateExit] = await Promise.all([create.exit, rotate.exit]);
    expect(createExit.code, createExit.stderr).toBe(0);
    expect(rotateExit.code, rotateExit.stderr).toBe(0);
    expect(early).toBe('waiting');
    expect(valueLines(w!)).toEqual(['API_KEY=v2']);
    await expect(resolveSecret('API_KEY', { scope: 'project', cwd: w!, actor: 'cli' })).resolves.toBe('v2');
  }, 60_000);
});
