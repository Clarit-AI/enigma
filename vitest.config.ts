import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Issue #29: fails loudly, before any test file runs, if node_modules is
    // empty/stale relative to package.json's pinned versions — the one
    // check that still runs even when vitest itself was resolved via a bare
    // `npx vitest` falling back to a cached/global install. See
    // scripts/vitest-toolchain-guard.mjs.
    globalSetup: ['./scripts/vitest-toolchain-guard.mjs'],
  },
});
