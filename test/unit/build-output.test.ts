import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DIST_DIR = join(REPO_ROOT, 'plugins/enigma/dist');
const BUNDLES = ['mcp-server.mjs', 'hooks.mjs', 'cli.mjs'];

describe('plugins/enigma/dist bundles (AC1)', () => {
  it.each(BUNDLES)('%s exists', (bundle) => {
    expect(existsSync(join(DIST_DIR, bundle))).toBe(true);
  });

  it('cli.mjs starts with the node shebang', () => {
    const content = readFileSync(join(DIST_DIR, 'cli.mjs'), 'utf8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it.each(BUNDLES)('%s does not contain the absolute repository path', (bundle) => {
    const content = readFileSync(join(DIST_DIR, bundle), 'utf8');
    expect(content).not.toContain(REPO_ROOT);
  });
});
