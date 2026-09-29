#!/usr/bin/env node
// Vitest globalSetup: bundle the render-ledger worker fixture to a plain
// .mjs file so the integration test can spawn it with `node`. The fixture
// source is TypeScript and lives at test/fixtures/ledger-worker.ts; the
// bundled output is at test/fixtures/ledger-worker.mjs. Run once per
// vitest invocation, idempotent on re-run.
//
// Why a bundle and not `node --experimental-strip-types`: the source
// files import each other with `.js` extensions (the project's ESM
// convention), and Node's strip-types loader only resolves extensions
// literally — it does not auto-resolve `.js` to `.ts`. esbuild's
// bundler-mode resolver, in contrast, handles those imports natively.
// The integration test then spawns a plain ESM file with no Node
// flags, matching the existing index-lock worker fixture's contract.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const entry = resolve(root, 'test/fixtures/ledger-worker.ts');
const outfile = resolve(root, 'test/fixtures/ledger-worker.mjs');

export default async function setup() {
  // Always rebuild — cheap, and keeps the fixture in lockstep with the
  // ledger source it imports (no stale-bundle surprises).
  if (existsSync(outfile)) rmSync(outfile);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });
}