import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Same define scripts/build.mjs gives the bundles (src/core/version.ts).
const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));

export default defineConfig({
  define: { __ENIGMA_VERSION__: JSON.stringify(version) },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Issue #29: fails loudly, before any test file runs, if node_modules is
    // empty/stale relative to package.json's pinned versions — the one
    // check that still runs even when vitest itself was resolved via a bare
    // `npx vitest` falling back to a cached/global install. See
    // scripts/vitest-toolchain-guard.mjs.
    // Issue #106: the render-ledger concurrency test spawns a worker
    // fixture (`test/fixtures/ledger-worker.ts`) that calls the real
    // `upsertTarget`/`removeNames` code. The fixture is TypeScript and
    // depends on `.js`-extension imports that Node's loader cannot
    // resolve under `--experimental-strip-types`; we bundle it to
    // `test/fixtures/ledger-worker.mjs` first via esbuild.
    globalSetup: ['./scripts/build-ledger-fixture.mjs', './scripts/vitest-toolchain-guard.mjs'],
  },
});
