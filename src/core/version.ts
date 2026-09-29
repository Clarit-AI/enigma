// The version of this Enigma build.
//
// `scripts/build.mjs` replaces `__ENIGMA_VERSION__` with the `package.json`
// version in every bundle, and `vitest.config.ts` does the same for tests, so
// the value travels with the bundle and needs no file next to it. The npm-bin
// layout has no `.claude-plugin/plugin.json` beside `dist/cli.mjs`, and the
// PATH shim needs to know its own version to decide whether a linked install
// is older. Anything that runs the source unbundled and undefined gets
// 'unknown', which does not parse as semver and so never justifies a re-point.
declare const __ENIGMA_VERSION__: string | undefined;

export const ENIGMA_VERSION: string = typeof __ENIGMA_VERSION__ === 'string' ? __ENIGMA_VERSION__ : 'unknown';
