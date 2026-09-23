// Artifact-resolution evidence for the index-lock loader (Issue #66).
//
// The loader must resolve the committed addon from a location determined by
// the EXECUTING MODULE'S OWN layout — an installed bundle resolves the
// sibling native/ directory, the source tree resolves plugins/enigma/native/
// — and must refuse E_LOCK_UNAVAILABLE when that artifact is absent, no
// matter what the ambient cwd or an ancestor directory happens to contain.
// A missing installed artifact must never silently switch layouts: a cwd
// holding a foreign checkout's native code is not the executing package.
//
// These tests esbuild a probe entry (the real src/ modules, loader included)
// into arbitrary temp layouts and spawn it with hostile cwds — the same
// installed-vs-checkout confusion that made the removed cwd candidate able
// to load another tree's native code in place of the shipped artifact.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mutateIndex, readIndex, upsertIndexEntry } from '../../src/core/index-store.js';
import type { IndexEntry } from '../../src/core/index-store.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAG = `${process.platform}-${process.arch}`;
const SHIPPED_NATIVE_DIR = join(REPO_ROOT, 'plugins', 'enigma', 'native');
const PROBE_ENTRY = join(REPO_ROOT, 'test', 'fixtures', 'native-loader-probe.ts');

let workDir: string;
let probeBundleSource: string;
let foreignCwd: string;

function entry(name: string): IndexEntry {
  return {
    name,
    scope: 'global',
    depository: 'encrypted',
    ref: `global/${name}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A fake "installed package" layout: <root>/plugins/enigma/dist/probe.mjs, optionally with its own native/<tag> artifact. */
function stageInstalledLayout(withArtifact: boolean): string {
  const pkgRoot = mkdtempSync(join(workDir, 'pkg-'));
  const distDir = join(pkgRoot, 'plugins', 'enigma', 'dist');
  mkdirSync(distDir, { recursive: true });
  const bundle = join(distDir, 'probe.mjs');
  copyFileSync(probeBundleSource, bundle);
  if (withArtifact) {
    const dst = join(pkgRoot, 'plugins', 'enigma', 'native', TAG);
    mkdirSync(dst, { recursive: true });
    copyFileSync(join(SHIPPED_NATIVE_DIR, TAG, 'index-lock.node'), join(dst, 'index-lock.node'));
  }
  return bundle;
}

function runProbe(
  bundle: string,
  opts: { cwd: string; nativeDirOverride?: string },
): { status: number | null; stdout: string; tmpHome: string } {
  const tmpHome = mkdtempSync(join(workDir, 'home-'));
  const env: NodeJS.ProcessEnv = { ...process.env, ENIGMA_HOME: tmpHome };
  delete env.ENIGMA_NATIVE_DIR;
  if (opts.nativeDirOverride !== undefined) env.ENIGMA_NATIVE_DIR = opts.nativeDirOverride;
  const r = spawnSync(process.execPath, [bundle], { cwd: opts.cwd, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, tmpHome };
}

describe('index-lock artifact resolution — deterministic layout, no ambient search (Issue #66)', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'enigma-resolution-'));
    probeBundleSource = join(workDir, 'probe-source.mjs');
    await esbuild.build({
      entryPoints: [PROBE_ENTRY],
      outfile: probeBundleSource,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      loader: { '.html': 'text' },
    });

    // A "foreign checkout": cwd contains plugins/enigma/native/<tag>/ holding
    // the REAL committed artifact — if the loader ever consults the cwd, the
    // addon loads and the probe mutates instead of refusing.
    foreignCwd = mkdtempSync(join(workDir, 'foreign-'));
    const foreignDir = join(foreignCwd, 'plugins', 'enigma', 'native', TAG);
    mkdirSync(foreignDir, { recursive: true });
    copyFileSync(join(SHIPPED_NATIVE_DIR, TAG, 'index-lock.node'), join(foreignDir, 'index-lock.node'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('installed layout with its artifact MISSING refuses E_LOCK_UNAVAILABLE — a populated cwd cannot substitute a foreign addon', () => {
    const bundle = stageInstalledLayout(false);
    const { status, stdout, tmpHome } = runProbe(bundle, { cwd: foreignCwd });

    expect(status).not.toBe(0);
    expect(stdout).toContain('ERROR E_LOCK_UNAVAILABLE');
    expect(stdout).not.toContain('MUTATED');
    // No index mutation: the refusal happened before any write path ran.
    expect(existsSync(join(tmpHome, 'index.json'))).toBe(false);
  });

  it('installed layout resolves the sibling native/ artifact of its own package', () => {
    const bundle = stageInstalledLayout(true);
    const { status, stdout, tmpHome } = runProbe(bundle, { cwd: foreignCwd });

    expect(status).toBe(0);
    expect(stdout).toContain('MUTATED');
    const index = JSON.parse(readFileSync(join(tmpHome, 'index.json'), 'utf8')) as { entries: IndexEntry[] };
    expect(index.entries.map((e) => e.name)).toEqual(['PROBE']);
  });

  it('a bundle outside every recognized layout refuses — no guess, no cwd search', () => {
    const stray = join(workDir, 'stray');
    mkdirSync(stray, { recursive: true });
    const bundle = join(stray, 'probe.mjs');
    copyFileSync(probeBundleSource, bundle);

    const { status, stdout } = runProbe(bundle, { cwd: foreignCwd });
    expect(status).not.toBe(0);
    expect(stdout).toContain('ERROR E_LOCK_UNAVAILABLE');
    expect(stdout).not.toContain('MUTATED');
  });

  it('ENIGMA_NATIVE_DIR is authoritative: a stray bundle loads the override artifact', () => {
    const stray = join(workDir, 'stray-override');
    mkdirSync(stray, { recursive: true });
    const bundle = join(stray, 'probe.mjs');
    copyFileSync(probeBundleSource, bundle);

    const { status, stdout } = runProbe(bundle, { cwd: foreignCwd, nativeDirOverride: SHIPPED_NATIVE_DIR });
    expect(status).toBe(0);
    expect(stdout).toContain('MUTATED');
  });

  it('ENIGMA_NATIVE_DIR is authoritative: an invalid override fails closed instead of falling back to the installed artifact', () => {
    const bundle = stageInstalledLayout(true); // the installed artifact IS present
    const emptyOverride = mkdtempSync(join(workDir, 'empty-override-'));

    const { status, stdout } = runProbe(bundle, { cwd: foreignCwd, nativeDirOverride: emptyOverride });
    expect(status).not.toBe(0);
    expect(stdout).toContain('ERROR E_LOCK_UNAVAILABLE');
    expect(stdout).not.toContain('MUTATED');
  });

  it('source layout (this vitest process) resolves the repo committed artifact', () => {
    const home = mkdtempSync(join(workDir, 'home-'));
    const prev = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = home;
    try {
      mutateIndex((cur) => upsertIndexEntry(cur, entry('SOURCE')));
      expect(readIndex().entries.map((e) => e.name)).toEqual(['SOURCE']);
    } finally {
      if (prev === undefined) delete process.env.ENIGMA_HOME;
      else process.env.ENIGMA_HOME = prev;
    }
  });
});
