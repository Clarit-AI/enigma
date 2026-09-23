import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  type: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
};

describe('package.json (AC6)', () => {
  it('has the scoped package name', () => {
    expect(pkg.name).toBe('@clarit.ai/enigma');
  });

  it('is an ESM package', () => {
    expect(pkg.type).toBe('module');
  });

  it('requires Node >=20', () => {
    expect(pkg.engines?.node).toBe('>=20');
  });

  it('exposes the enigma bin pointing at the built CLI', () => {
    expect(pkg.bin?.enigma).toBe('plugins/enigma/dist/cli.mjs');
  });

  it('publishes only the plugin dist and native directories', () => {
    // Issue #66: the first-party flock addon ships beside dist/ so a
    // marketplace/npm install carries the committed per-platform artifacts.
    expect(pkg.files).toEqual(['plugins/enigma/dist', 'plugins/enigma/native']);
  });
});
