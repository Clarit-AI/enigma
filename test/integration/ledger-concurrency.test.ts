// Real-process evidence for the render ledger (Issue #106) under
// concurrent upsert + removeNames calls.
//
// The unit suite in test/unit/render/ledger.test.ts covers the ledger's
// functional contract (RMW, E_CONFIG_CORRUPT, partial-removal
// persistence, sentinel). Here we prove the kernel-held ledger lock
// actually serializes cross-process writers — the contract that
// `acquireFileLock` + `writeJsonFileAtomic` together deliver.
//
// The fixture is bundled to test/fixtures/ledger-worker.mjs by the
// vitest globalSetup (scripts/build-ledger-fixture.mjs). Each child
// process invokes the real `upsertTarget` / `removeNames` from
// src/render/ledger.ts — no fs mocks, the kernel is the arbiter.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLedger } from '../../src/render/ledger.js';

// The bundled worker fixture lives in a per-run tmpdir path (reviewer
// r2 A2 — concurrent vitest runs would otherwise share one file).
// vitest's globalSetup (`scripts/build-ledger-fixture.mjs`) sets
// `ENIGMA_LEDGER_WORKER_PATH` before any test runs.
const workerPath = process.env.ENIGMA_LEDGER_WORKER_PATH ?? '';
if (!workerPath) {
  throw new Error(
    'ENIGMA_LEDGER_WORKER_PATH not set; scripts/build-ledger-fixture.mjs should set it via vitest globalSetup',
  );
}
// Bundling the fixture breaks `native-lock.ts`'s layout-based
// artifactLocation (it looks for `<pkg>/dist/` or `<repo>/src/core/`);
// the override below is the AUTHORITATIVE path the child uses to
// locate the committed native addon (Issue #106 lock mechanism).
const NATIVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'enigma', 'native');

function runWorker(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, ENIGMA_NATIVE_DIR: NATIVE_DIR },
    });
    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
    }
    child.on('exit', (code: number | null) => resolvePromise({ code, stdout, stderr }));
  });
}

describe('render ledger — concurrent upsert + removeNames through real processes (Issue #106)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-ledger-rp-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('4 processes × distinct targets all upsert; one removes; every expected target survives the kernel lock', async () => {
    // 4 child processes: 3 upsert distinct targets, 1 removes a name
    // that none of the 3 just upserted. The kernel-held ledger lock
    // serializes all four so every upsert lands and the removal
    // (which acts on a non-existent name) is a no-op.
    const env = { ENIGMA_HOME: tmpHome };
    // Pre-create ENIGMA_HOME so child processes inherit a valid dir.
    writeFileSync(join(tmpHome, '.keep'), '');

    const results = await Promise.all([
      runWorker(['upsert', 'proj-a', '/wt-a', '/wt-a/.env', 'ALPHA', 'BETA'], env),
      runWorker(['upsert', 'proj-a', '/wt-b', '/wt-b/.env', 'GAMMA'], env),
      runWorker(['upsert', 'proj-b', '/wt-c', '/wt-c/.env', 'DELTA'], env),
      runWorker(['remove', 'NEVER_PRESENT'], env),
    ]);
    for (const r of results) {
      expect(r.code, `child stderr: ${r.stderr}`).toBe(0);
    }

    // Every upserted target survives, with the exact names it was given.
    const ledger = readLedger();
    const byFile = Object.fromEntries(ledger.targets.map((t) => [t.file, t.names]));
    expect(byFile['/wt-a/.env']).toEqual(['ALPHA', 'BETA']);
    expect(byFile['/wt-b/.env']).toEqual(['GAMMA']);
    expect(byFile['/wt-c/.env']).toEqual(['DELTA']);
    expect(ledger.targets).toHaveLength(3);
  });

  it('concurrent upsert to the SAME (projectId, worktree, file) merges names sorted-unique across processes', async () => {
    // Three processes each upsert to the same target with one name.
    // After all complete, the merged `names[]` must contain every name
    // and be sorted unique — the ledger lock + RMW must serialize the
    // merges so no update is lost.
    const env = { ENIGMA_HOME: tmpHome };
    writeFileSync(join(tmpHome, '.keep'), '');

    const results = await Promise.all([
      runWorker(['upsert', 'proj-a', '/wt', '/wt/.env', 'A'], env),
      runWorker(['upsert', 'proj-a', '/wt', '/wt/.env', 'B'], env),
      runWorker(['upsert', 'proj-a', '/wt', '/wt/.env', 'C'], env),
    ]);
    for (const r of results) {
      expect(r.code, `child stderr: ${r.stderr}`).toBe(0);
    }

    const ledger = readLedger();
    expect(ledger.targets).toHaveLength(1);
    expect(ledger.targets[0]?.names).toEqual(['A', 'B', 'C']);
  });

  it('three concurrent upserts to one target + a remove of an unrelated name: every upsert name is reflected in the final state', async () => {
    // Three children each upsert one distinct name concurrently; a
    // fourth removes a name none of them touched. Final state must
    // contain every upserted name (sorted-unique merge across
    // processes) and the unrelated remove is a no-op. This is
    // deterministic in its outcome regardless of process order —
    // each child either adds or removes; the merge + the
    // removeNames no-op are both order-independent.
    const env = { ENIGMA_HOME: tmpHome };
    writeFileSync(join(tmpHome, '.keep'), '');

    const results = await Promise.all([
      runWorker(['upsert', 'proj-a', '/wt', '/wt/.env', 'A'], env),
      runWorker(['upsert', 'proj-a', '/wt', '/wt/.env', 'B'], env),
      runWorker(['upsert', 'proj-a', '/wt', '/wt/.env', 'C'], env),
      runWorker(['remove', 'NEVER_PRESENT'], env),
    ]);
    for (const r of results) {
      expect(r.code, `child stderr: ${r.stderr}`).toBe(0);
    }

    const ledger = readLedger();
    expect(ledger.targets).toHaveLength(1);
    expect(ledger.targets[0]?.names).toEqual(['A', 'B', 'C']);
  });

  it('a removeNames in a separate process persists a partial removal (regression for QA C1 / codex blocking)', async () => {
    // First child upserts [A, B]; second child then removes [A].
    // Both run as separate processes so we exercise the real
    // `acquireFileLock` + `writeJsonFileAtomic` round-trip. The
    // final names[] must be exactly [B] — partial removal must
    // persist even when no target was dropped.
    const env = { ENIGMA_HOME: tmpHome };
    writeFileSync(join(tmpHome, '.keep'), '');

    const a = await runWorker(['upsert', 'proj-a', '/wt', '/wt/.env', 'A', 'B'], env);
    expect(a.code, `child stderr: ${a.stderr}`).toBe(0);
    const b = await runWorker(['remove', 'A'], env);
    expect(b.code, `child stderr: ${b.stderr}`).toBe(0);

    const ledger = readLedger();
    expect(ledger.targets).toHaveLength(1);
    expect(ledger.targets[0]?.names).toEqual(['B']);
  });

  it('a real concurrent removeNames racing an upsert never loses data (QA r2 L1)', async () => {
    // Seed: parent process gives the target names [A, B] so a real
    // removeNames can take a name that IS carried. Then two children
    // race concurrently:
    //   - child A: removeNames [A]  — actually removes from the seed
    //   - child B: upsert [C]         — adds a third name
    // The kernel-held ledger lock serializes them, but in an
    // unspecified order — so the final state can be either:
    //   * A runs first: target has [B]; then B upserts [C] → [B, C].
    //   * B runs first: target has [A, B, C]; then A removes [A] → [B, C].
    // Both serializations land on [B, C] (B is the only name that
    // was never targeted by a removal). Either way the target
    // survives and no phantom name appears.
    const env = { ENIGMA_HOME: tmpHome };
    writeFileSync(join(tmpHome, '.keep'), '');

    // Seed: write [A, B] directly via the bundled worker (single
    // process, deterministic) so the racing children see [A, B].
    const seed = await runWorker(['upsert', 'proj-a', '/wt', '/wt/.env', 'A', 'B'], env);
    expect(seed.code, `seed stderr: ${seed.stderr}`).toBe(0);

    const results = await Promise.all([
      runWorker(['remove', 'A'], env),
      runWorker(['upsert', 'proj-a', '/wt', '/wt/.env', 'C'], env),
    ]);
    for (const r of results) {
      expect(r.code, `child stderr: ${r.stderr}`).toBe(0);
    }

    const ledger = readLedger();
    // The target survives — neither child could drop it (A only
    // removes a name, not the whole target; B upserts to it).
    expect(ledger.targets).toHaveLength(1);
    const names = ledger.targets[0]?.names ?? [];
    // Both serializations land on exactly [B, C] (see above). A lost C
    // or a surviving A means one writer clobbered the other's write.
    expect(names).toEqual(['B', 'C']);
  });
});