import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeShim, ensureCliShim } from '../../../src/core/shim.js';

// The shim exists because a marketplace install leaves the bundled CLI off
// PATH, which makes read-guard's own remediation advice ("use enigma run")
// unrunnable. It writes to a real directory, so the tests below are about the
// rules that keep that write timid: never shadow a real install, never touch a
// non-symlink, never write outside a directory that is already on PATH, never
// throw, and never leave temp files behind.
describe('PATH shim', () => {
  let tmp: string;
  let pluginRoot: string;
  let cli: string;
  let binDir: string;
  let otherBin: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'enigma-shim-'));
    pluginRoot = join(tmp, 'plugin');
    mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
    cli = join(pluginRoot, 'dist', 'cli.mjs');
    writeFileSync(cli, '#!/usr/bin/env node\n');
    chmodSync(cli, 0o755);

    binDir = join(tmp, 'bin');
    otherBin = join(tmp, 'other-bin');
    mkdirSync(binDir);
    mkdirSync(otherBin);

    delete process.env.ENIGMA_NO_PATH_SHIM;
  });

  afterEach(() => {
    delete process.env.ENIGMA_NO_PATH_SHIM;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A plugin install laid out like a marketplace one; `manifestName` null omits the manifest. */
  function makePlugin(root: string, manifestName: string | null): string {
    mkdirSync(join(root, 'dist'), { recursive: true });
    const bundle = join(root, 'dist', 'cli.mjs');
    writeFileSync(bundle, '#!/usr/bin/env node\n');
    if (manifestName !== null) {
      mkdirSync(join(root, '.claude-plugin'));
      writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: manifestName }));
    }
    return bundle;
  }

  it('creates the shim in the first writable directory on PATH', () => {
    const result = ensureCliShim({ pluginRoot, pathEnv: binDir });

    expect(result.status).toBe('installed');
    expect(result.target).toBe(join(binDir, 'enigma'));
    expect(readlinkSync(join(binDir, 'enigma'))).toBe(cli);
  });

  it('is idempotent — a second run writes nothing and still reports present', () => {
    ensureCliShim({ pluginRoot, pathEnv: binDir });
    const again = ensureCliShim({ pluginRoot, pathEnv: binDir });

    expect(again.status).toBe('present');
    expect(readlinkSync(join(binDir, 'enigma'))).toBe(cli);
  });

  it('leaves no temp file behind', () => {
    ensureCliShim({ pluginRoot, pathEnv: binDir });

    expect(readdirSync(binDir)).toEqual(['enigma']);
  });

  describe('never shadows a real install', () => {
    it('refuses to write when a working enigma already exists earlier on PATH', () => {
      const mine = join(binDir, 'enigma');
      writeFileSync(mine, '#!/bin/sh\necho a real enigma\n', { mode: 0o755 });

      const result = ensureCliShim({ pluginRoot, pathEnv: binDir });

      expect(result.status).toBe('occupied');
      expect(readFileSync(mine, 'utf8')).toContain('a real enigma');
    });

    it('refuses to write when a working enigma exists LATER on PATH', () => {
      // The regression this guards: creating in `binDir` would shadow the
      // existing install in `otherBin`, because PATH order wins.
      writeFileSync(join(otherBin, 'enigma'), 'real', { mode: 0o755 });

      const result = ensureCliShim({ pluginRoot, pathEnv: [binDir, otherBin].join(':') });

      expect(result.status).toBe('occupied');
      expect(result.target).toBe(join(otherBin, 'enigma'));
      expect(existsSync(join(binDir, 'enigma'))).toBe(false);
    });

    it('never replaces a directory that happens to be called enigma', () => {
      const impostor = join(binDir, 'enigma');
      mkdirSync(impostor);

      expect(ensureCliShim({ pluginRoot, pathEnv: binDir }).status).toBe('occupied');
      expect(statSync(impostor).isDirectory()).toBe(true);
    });
  });

  describe('self-heals a stale shim', () => {
    it('re-points a dangling symlink left by a plugin upgrade', () => {
      // What a version bump actually leaves behind: the link survives, the
      // plugin directory it named is gone.
      const dead = join(tmp, 'old-plugin', 'dist', 'cli.mjs');
      symlinkSync(dead, join(binDir, 'enigma'));

      const result = ensureCliShim({ pluginRoot, pathEnv: binDir });

      expect(result.status).toBe('repointed');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(cli);
    });

    it('resolves a relative dangling link before replacing it', () => {
      symlinkSync('../old-plugin/dist/cli.mjs', join(binDir, 'enigma'));

      expect(ensureCliShim({ pluginRoot, pathEnv: binDir }).status).toBe('repointed');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(cli);
    });
  });

  // Issue #94: a plugin upgrade that keeps the previous version on disk leaves a
  // WORKING link to the old bundle. That is stale, not somebody else's `enigma`.
  describe('self-heals a link to an older Enigma plugin install that still exists', () => {
    it('re-points it at the current CLI', () => {
      const older = makePlugin(join(tmp, 'older-plugin'), 'enigma');
      symlinkSync(older, join(binDir, 'enigma'));

      const result = ensureCliShim({ pluginRoot, pathEnv: binDir });

      expect(result.status).toBe('repointed');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(cli);
      expect(readdirSync(binDir)).toEqual(['enigma']);
    });

    it('resolves a relative link to the older install', () => {
      makePlugin(join(tmp, 'older-plugin'), 'enigma');
      symlinkSync('../older-plugin/dist/cli.mjs', join(binDir, 'enigma'));

      expect(ensureCliShim({ pluginRoot, pathEnv: binDir }).status).toBe('repointed');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(cli);
    });

    it('reports pending instead of writing in read-only mode', () => {
      const older = makePlugin(join(tmp, 'older-plugin'), 'enigma');
      symlinkSync(older, join(binDir, 'enigma'));

      const result = ensureCliShim({ pluginRoot, pathEnv: binDir, write: false });

      expect(result.status).toBe('pending');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(older);
    });

    it('reports occupied, not a shadowing new shim, when the stale link sits in an unsafe directory', () => {
      const older = makePlugin(join(tmp, 'older-plugin'), 'enigma');
      symlinkSync(older, join(binDir, 'enigma'));
      chmodSync(binDir, 0o775);

      const result = ensureCliShim({ pluginRoot, pathEnv: `${binDir}:${otherBin}` });

      expect(result.status).toBe('occupied');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(older);
      expect(existsSync(join(otherBin, 'enigma'))).toBe(false);
    });

    it('treats a link that reaches the current CLI through another symlink as already correct', () => {
      const aliasRoot = join(tmp, 'plugin-alias');
      symlinkSync(pluginRoot, aliasRoot);
      symlinkSync(join(aliasRoot, 'dist', 'cli.mjs'), join(binDir, 'enigma'));

      const result = ensureCliShim({ pluginRoot, pathEnv: binDir });

      expect(result.status).toBe('present');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(join(aliasRoot, 'dist', 'cli.mjs'));
    });
  });

  describe('still leaves a working link to anything that is not an Enigma plugin bundle', () => {
    it('reports occupied for a symlink to a real enigma binary', () => {
      const real = join(tmp, 'real-install', 'enigma');
      mkdirSync(join(tmp, 'real-install'));
      writeFileSync(real, '#!/bin/sh\necho a real enigma\n', { mode: 0o755 });
      symlinkSync(real, join(binDir, 'enigma'));

      const result = ensureCliShim({ pluginRoot, pathEnv: binDir });

      expect(result.status).toBe('occupied');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(real);
    });

    it('reports occupied for another project\'s dist/cli.mjs that has no Enigma manifest', () => {
      const lookalike = makePlugin(join(tmp, 'someone-elses-tool'), null);
      symlinkSync(lookalike, join(binDir, 'enigma'));

      expect(ensureCliShim({ pluginRoot, pathEnv: binDir }).status).toBe('occupied');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(lookalike);
    });

    it('reports occupied for a plugin whose manifest names a different plugin', () => {
      const other = makePlugin(join(tmp, 'other-plugin'), 'not-enigma');
      symlinkSync(other, join(binDir, 'enigma'));

      expect(ensureCliShim({ pluginRoot, pathEnv: binDir }).status).toBe('occupied');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(other);
    });

    it('reports occupied when the manifest is not valid JSON', () => {
      const broken = makePlugin(join(tmp, 'broken-plugin'), 'enigma');
      writeFileSync(join(tmp, 'broken-plugin', '.claude-plugin', 'plugin.json'), '{ not json');
      symlinkSync(broken, join(binDir, 'enigma'));

      expect(ensureCliShim({ pluginRoot, pathEnv: binDir }).status).toBe('occupied');
    });
  });

  describe('never uses a directory that group or other can write', () => {
    it.each(['775', '757', '777', '1777'])('skips a mode-%s directory as a shim location', (octal) => {
      chmodSync(binDir, parseInt(octal, 8));

      const result = ensureCliShim({ pluginRoot, pathEnv: `${binDir}:${otherBin}` });

      expect(result.status).toBe('installed');
      expect(result.target).toBe(join(otherBin, 'enigma'));
      expect(existsSync(join(binDir, 'enigma'))).toBe(false);
    });

    it('reports no-writable-dir when every candidate is shared', () => {
      chmodSync(binDir, 0o777);

      expect(ensureCliShim({ pluginRoot, pathEnv: binDir }).status).toBe('no-writable-dir');
      expect(existsSync(join(binDir, 'enigma'))).toBe(false);
    });

    it('does not refresh a dangling link in a shared directory either', () => {
      symlinkSync(join(tmp, 'old-plugin', 'dist', 'cli.mjs'), join(binDir, 'enigma'));
      chmodSync(binDir, 0o777);

      const result = ensureCliShim({ pluginRoot, pathEnv: binDir });

      expect(result.status).toBe('no-writable-dir');
      expect(readlinkSync(join(binDir, 'enigma'))).toBe(join(tmp, 'old-plugin', 'dist', 'cli.mjs'));
    });
  });

  describe('only ever writes where it is already on PATH', () => {
    it('ignores relative PATH entries entirely', () => {
      // `./bin` is a directory inside somebody's checkout. Writing an
      // executable into a project we were merely pointed at is not ours to do.
      const result = ensureCliShim({ pluginRoot, pathEnv: `./bin:${binDir}` });

      expect(result.status).toBe('installed');
      expect(result.target).toBe(join(binDir, 'enigma'));
    });

    it('reports no-writable-dir rather than guessing when nothing on PATH is writable', () => {
      const result = ensureCliShim({ pluginRoot, pathEnv: '/nonexistent-dir-a:/nonexistent-dir-b' });

      expect(result.status).toBe('no-writable-dir');
    });

    it('de-duplicates repeated PATH entries', () => {
      const result = ensureCliShim({ pluginRoot, pathEnv: `${binDir}:${binDir}:${binDir}` });

      expect(result.status).toBe('installed');
      expect(result.target).toBe(join(binDir, 'enigma'));
    });
  });

  describe('degrades instead of failing', () => {
    it('reports unavailable outside a plugin install', () => {
      const result = ensureCliShim({ pluginRoot: null, pathEnv: binDir });

      expect(result.status).toBe('unavailable');
      expect(existsSync(join(binDir, 'enigma'))).toBe(false);
    });

    it('reports unavailable when the plugin root has no CLI bundle', () => {
      const empty = join(tmp, 'empty');
      mkdirSync(empty);

      expect(ensureCliShim({ pluginRoot: empty, pathEnv: binDir }).status).toBe('unavailable');
    });

    it('honours ENIGMA_NO_PATH_SHIM=1 as an opt-out', () => {
      process.env.ENIGMA_NO_PATH_SHIM = '1';

      expect(ensureCliShim({ pluginRoot, pathEnv: binDir }).status).toBe('disabled');
      expect(existsSync(join(binDir, 'enigma'))).toBe(false);
    });

    it('never throws, whatever PATH looks like', () => {
      for (const pathEnv of ['', ':::', '\0', binDir]) {
        expect(() => ensureCliShim({ pluginRoot, pathEnv })).not.toThrow();
      }
    });
  });

  describe('read-only mode', () => {
    it('reports what a session would do without writing', () => {
      const result = ensureCliShim({ pluginRoot, pathEnv: binDir, write: false });

      expect(result.status).toBe('pending');
      expect(result.target).toBe(join(binDir, 'enigma'));
      expect(existsSync(join(binDir, 'enigma'))).toBe(false);
    });

    it('still reports present for a shim that is already correct', () => {
      ensureCliShim({ pluginRoot, pathEnv: binDir });

      expect(ensureCliShim({ pluginRoot, pathEnv: binDir, write: false }).status).toBe('present');
    });
  });

  describe('the line it tells the session', () => {
    it('names the created path and how to use it', () => {
      const line = describeShim(ensureCliShim({ pluginRoot, pathEnv: binDir }));

      expect(line).toContain(join(binDir, 'enigma'));
      expect(line).toContain('enigma run');
    });

    it('stays quiet for statuses that are not news', () => {
      for (const status of ['present', 'unavailable', 'disabled'] as const) {
        expect(describeShim({ status, target: null, cli, link: null, detail: null })).toBeNull();
      }
    });

    it('gives a runnable fallback when the shim cannot be placed', () => {
      const line = describeShim(ensureCliShim({ pluginRoot, pathEnv: '/nonexistent-dir-a' }));

      expect(line).toContain('node "');
      expect(line).toContain(cli);
    });
  });
});
