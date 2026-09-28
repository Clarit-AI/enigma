import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isMainModule } from '../../../src/core/is-main-module.js';

// This guard decides whether a bundle runs at all. The naive spelling of it
// (`import.meta.url === new URL(process.argv[1], 'file:').href`) compares a
// *resolved* module URL against a *literal* argument, so it answers "no" the
// moment either side is a symlink — which is how the CLI is invoked once it is
// on PATH, and how npm's `bin` invokes it. `enigma doctor` then ran, was given
// no argv, and exited 0 having printed nothing: a silent no-op that reads as
// success. These tests pin the symlink case so that cannot come back.
describe('isMainModule', () => {
  let dir: string;
  let realFile: string;
  let realUrl: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'enigma-mainmod-'));
    realFile = join(dir, 'cli.mjs');
    writeFileSync(realFile, '// bundle\n');
    realUrl = pathToFileURL(realFile).href;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is true when the entry path is this file', () => {
    expect(isMainModule(realUrl, realFile)).toBe(true);
  });

  it('is true when the entry path is a SYMLINK to this file', () => {
    const link = join(dir, 'enigma');
    symlinkSync(realFile, link);

    expect(isMainModule(realUrl, link)).toBe(true);
  });

  it('is true when the entry path is a symlink to a SYMLINK to this file', () => {
    const inner = join(dir, 'inner');
    const outer = join(dir, 'enigma');
    symlinkSync(realFile, inner);
    symlinkSync(inner, outer);

    expect(isMainModule(realUrl, outer)).toBe(true);
  });

  it('is false for a different file in the same directory', () => {
    const other = join(dir, 'hooks.mjs');
    writeFileSync(other, '// other\n');

    expect(isMainModule(realUrl, other)).toBe(false);
  });

  it('is false when there is no entry path at all', () => {
    expect(isMainModule(realUrl, undefined)).toBe(false);
  });

  it('is false for an entry path that does not exist, without throwing', () => {
    // Node reaches this guard at module scope; a throw here would take down
    // whichever process imported the bundle.
    expect(isMainModule(realUrl, join(dir, 'gone', 'cli.mjs'))).toBe(false);
  });
});
