// Real-process evidence for Issue #125 (per-secret operation lock) and Issue #87 (encrypted vault lock).
//
// #125 repro 2: a writer has stored its depository copy but not yet committed the index. Before the lock, a
// concurrent `enigma move` read the index, then deleted that copy (same address, same value) during its
// cleanup, and the writer's commit left the index pointing at nothing (E_NOT_FOUND). Now the move waits for the
// writer to finish, then moves a consistent secret.
//
// #87: several processes writing different names into the encrypted vault at once. Before the vault lock, each
// read the same snapshot and the later rename dropped the others' entries.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findIndexEntry, readIndex } from '../../src/core/index-store.js';
import { projectId } from '../../src/core/project.js';
import { encryptedDepositoryModule } from '../../src/storage/depositories/encrypted.js';
import { resolveSecret, setSecret } from '../../src/storage/manager.js';
import { makeRepo, makeSandbox } from '../unit/render/fanout-helpers.js';
import type { Sandbox } from '../unit/render/fanout-helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = resolve(here, '..', '..', 'plugins', 'enigma', 'native');
let bundleDir: string;
let workerPath: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'enigma-op-lock-worker-'));
  workerPath = join(bundleDir, 'secret-op-lock-worker.mjs');
  await build({
    entryPoints: [resolve(here, 'secret-op-lock-worker.ts')],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });
});

afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

let sb: Sandbox;
// Every spawned worker, so a failed assertion cannot leave one parked forever on a `go` file that teardown removes.
let children: ChildProcess[] = [];
beforeEach(() => {
  sb = makeSandbox();
  children = [];
});
afterEach(async () => {
  const live = children.filter((c) => c.exitCode === null && c.signalCode === null);
  await Promise.all(
    live.map(
      (c) =>
        new Promise<void>((r) => {
          c.once('exit', () => r());
          c.kill('SIGKILL');
        }),
    ),
  );
  sb.cleanup();
});

interface Run {
  exit: Promise<{ code: number | null; stderr: string }>;
  exited: () => boolean;
}

function run(args: string[]): Run {
  const child = spawn(process.execPath, [workerPath, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ENIGMA_HOME: process.env.ENIGMA_HOME!, ENIGMA_NATIVE_DIR: NATIVE_DIR },
  });
  children.push(child);
  let stderr = '';
  let done = false;
  child.stderr!.on('data', (c: Buffer) => (stderr += c.toString()));
  const exit = new Promise<{ code: number | null; stderr: string }>((r) =>
    child.on('exit', (code) => {
      done = true;
      r({ code, stderr });
    }),
  );
  return { exit, exited: () => done };
}

async function waitFor(file: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('per-secret operation lock — real processes (Issue #125)', () => {
  it('repro 2: a move cannot delete a writer\'s stored copy before that writer commits; the secret stays resolvable', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    await setSecret({ name: 'TOKEN', value: 'v1', scope: 'project', depository: 'env', cwd: w!, actor: 'cli' });

    const goFile = join(sb.home, 'go');
    const signalFile = join(sb.home, 'written');
    // Same-value env rotate: writes TOKEN=v1 into the env block, then parks before its index commit.
    const writer = run(['set', w!, 'TOKEN', 'v1', 'env', goFile, signalFile]);
    await waitFor(signalFile);

    const mover = run(['move', w!, 'TOKEN', 'encrypted']);
    await new Promise((r) => setTimeout(r, 750));
    expect(mover.exited()).toBe(false); // waiting on TOKEN's operation lock, not racing the writer

    writeFileSync(goFile, 'go');
    expect((await writer.exit).code).toBe(0);
    const moved = await mover.exit;
    expect(moved.code, moved.stderr).toBe(0);

    const entry = findIndexEntry(readIndex(), 'TOKEN', 'project', projectId(w!));
    expect(entry?.depository).toBe('encrypted');
    await expect(resolveSecret('TOKEN', { scope: 'project', cwd: w!, actor: 'cli' })).resolves.toBe('v1');
  }, 60_000);
});

describe('encrypted vault lock — real processes (Issue #87)', () => {
  it('concurrent writers of different names never drop one another\'s entries', async () => {
    const writers = 4;
    const perWriter = 40;
    const runs = Array.from({ length: writers }, (_, i) => run(['vault', `W${i}_`, String(perWriter)]));
    for (const r of runs) expect((await r.exit).code).toBe(0);

    const dep = encryptedDepositoryModule.create({});
    const missing: string[] = [];
    for (let i = 0; i < writers; i++) {
      for (let j = 0; j < perWriter; j++) {
        const ref = `global/W${i}_${j}`;
        if (!(await dep.has(ref))) missing.push(ref);
      }
    }
    expect(missing).toEqual([]);
    await expect(dep.resolve('global/W3_39')).resolves.toBe('value-W3_39');
  }, 60_000);
});
