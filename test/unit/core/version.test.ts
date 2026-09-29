import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENIGMA_VERSION } from '../../../src/core/version.js';

function versionOf(path: string): unknown {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version;
}

// ENIGMA_VERSION replaced hardcoded strings that were missed in two release
// bumps, so the one thing worth pinning is that it tracks the manifests a
// release bumps by hand.
describe('ENIGMA_VERSION', () => {
  it('is the package.json version, which the plugin manifest must match', () => {
    expect(ENIGMA_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(ENIGMA_VERSION).toBe(versionOf('package.json'));
    expect(ENIGMA_VERSION).toBe(versionOf('plugins/enigma/.claude-plugin/plugin.json'));
  });
});
