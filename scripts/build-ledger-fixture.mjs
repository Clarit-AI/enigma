#!/usr/bin/env node
// Vitest globalSetup (Issue #106): bundle the render-ledger worker
// fixture to a per-run path under os.tmpdir() so concurrent vitest
// runs do not race on a shared file (reviewer r2 A2). The path is
// exposed to the test process via `ENIGMA_LEDGER_WORKER_PATH`; the
// integration tests read it from `process.env` and spawn the
// bundled file with `node`.
//
// The fixture source is TypeScript and lives at
// test/fixtures/ledger-worker.ts; the bundle is generated on every
// run and torn down when vitest exits. Because the output lives
// under `os.tmpdir()`, no .gitignore or eslint-ignore entry is
// needed for the bundle path.
//
// Why a bundle and not `node --experimental-strip-types`: the
// source files import each other with `.js` extensions (the
// project's ESM convention), and Node's strip-types loader only
// resolves extensions literally — it does not auto-resolve `.js` to
// `.ts`. esbuild's bundler-mode resolver, in contrast, handles
// those imports natively. The integration test then spawns a plain
// ESM file with no Node flags, matching the index-lock worker
// fixture's contract.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(root, 'test/fixtures/ledger-worker.ts');
// Per-run output path (reviewer r2 A2): concurrent vitest runs would
// otherwise share `test/fixtures/ledger-worker.mjs`. Use a unique
// tmpdir entry so each run owns its bundle, then clean it up in
// teardown.
const tmpRoot = mkdtempSync(join(tmpdir(), 'enigma-ledger-worker-'));
const outfile = resolve(tmpRoot, 'ledger-worker.mjs');

export async function setup() {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });
  // Expose the bundle path to the test process and any spawned
  // child processes (the latter inherit the env).
  process.env.ENIGMA_LEDGER_WORKER_PATH = outfile;
}

export async function teardown() {
  rmSync(tmpRoot, { recursive: true, force: true });
}