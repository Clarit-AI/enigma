// vitest globalSetup (Issue #29): the one hook that runs no matter which
// vitest binary is invoking it. `npm test`/`npm run test:file` already
// resolve vitest safely (npm always uses node_modules/.bin, so an absent
// binary fails loudly on its own — see scripts/check-toolchain.mjs's header
// comment) — but a bare `npx vitest run <file>`, the exact command a lane
// reaches for to run one file or a repeat loop, bypasses npm's resolution
// entirely and can silently fall back to a cached or global vitest. That
// binary still loads THIS repo's vitest.config.ts and therefore still runs
// this globalSetup, so it's the one place a version guard can't be skipped
// by the invocation path people actually take.
import { checkToolchain } from './check-toolchain.mjs';

export default function setup() {
  const problems = checkToolchain();
  if (problems.length > 0) {
    throw new Error(
      [
        'vitest toolchain guard (Issue #29) failed:',
        ...problems.map((p) => `  - ${p}`),
        '',
        'This vitest run is not using the toolchain this repo pins in package.json — likely an empty ' +
          'or stale node_modules with `npx vitest` falling back to a cached or global install instead ' +
          'of failing. Run `npm ci`, then use `npm test` or `npm run test:file -- <path>` rather than ' +
          'bare `npx vitest`.',
      ].join('\n'),
    );
  }
}
