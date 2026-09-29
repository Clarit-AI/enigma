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
    // Issue #106 (reviewer r2 A2): the toolchain guard runs FIRST so a
    // broken toolchain fails fast without spending a bundle cycle;
    // the ledger-worker build runs second and writes the bundle to a
    // per-run tmpdir path exposed via ENIGMA_LEDGER_WORKER_PATH.
    globalSetup: ['./scripts/vitest-toolchain-guard.mjs', './scripts/build-ledger-fixture.mjs'],
  },
});
