// Manual probes for the round-2 review's BLOCKING regression (H1 / B1):
// trailing-slash, relative, and `..`-containing ENIGMA_HOME paths must
// still produce a working kernel lock. Pre-fix code skipped the mkdir
// step on those inputs, so `enigma add` / `upsertTarget` failed with
// `E_LOCK_TIMEOUT` (regression from base).
//
// These tests exercise the production code path
// `acquireFileLock(indexLockPath())` → RMW from inside `mutateIndex`,
// which is the same path the CLI hits on every index write.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mutateIndex, readIndex } from '../../../src/core/index-store.js';
import { acquireFileLock } from '../../../src/core/file-lock.js';
import { indexLockPath, indexPath, renderLedgerPath, renderLockPath } from '../../../src/core/paths.js';
import { readLedger, upsertTarget } from '../../../src/render/ledger.js';

describe('ensureLockDir path containment — round-2 review H1 / B1 (BLOCKING regression fix)', () => {
  let originalHome: string | undefined;
  const scratchHomes: string[] = [];

  beforeEach(() => {
    originalHome = process.env.ENIGMA_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    for (const home of scratchHomes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  function freshHome(suffix: string): string {
    const home = mkdtempSync(join(tmpdir(), `enigma-home-${suffix}-`));
    scratchHomes.push(home);
    return home;
  }

  function upsertProbe(home: string): void {
    process.env.ENIGMA_HOME = home;
    mutateIndex((current) => ({
      ...current,
      entries: [
        ...current.entries,
        {
          name: 'PROBE_KEY',
          scope: 'global',
          depository: 'encrypted',
          ref: 'global/PROBE_KEY',
          createdAt: '2026-09-29T15:00:00.000Z',
          updatedAt: '2026-09-29T15:00:00.000Z',
        },
      ],
    }));
  }

  it('trailing-slash ENIGMA_HOME: mutateIndex succeeds and the index is written', () => {
    // A home that does not exist yet, with a trailing slash — the
    // regression case (an existing home hides it: no mkdir is needed).
    const rawHome = join(freshHome('trailing-slash'), 'home');
    const homeWithSlash = `${rawHome}/`;
    upsertProbe(homeWithSlash);

    expect(existsSync(indexPath())).toBe(true);
    expect(existsSync(indexLockPath())).toBe(true);
    expect(readIndex().entries.map((e) => e.name)).toEqual(['PROBE_KEY']);
  });

  it('relative ENIGMA_HOME: resolves relative to cwd, then mutateIndex succeeds', () => {
    // Build a relative path under a freshly-created cwd tempdir and
    // set ENIGMA_HOME to it.
    const cwd = mkdtempSync(join(tmpdir(), 'enigma-home-rel-'));
    scratchHomes.push(cwd);
    const originalCwd = process.cwd();
    process.chdir(cwd);
    const originalHomeSnap = originalHome;
    try {
      process.env.ENIGMA_HOME = './home';
      mutateIndex((current) => ({
        ...current,
        entries: [...current.entries, {
          name: 'PROBE_KEY',
          scope: 'global',
          depository: 'encrypted',
          ref: 'global/PROBE_KEY',
          createdAt: '2026-09-29T15:00:00.000Z',
          updatedAt: '2026-09-29T15:00:00.000Z',
        }],
      }));
      expect(existsSync(indexPath())).toBe(true);
      expect(readIndex().entries.map((e) => e.name)).toEqual(['PROBE_KEY']);
    } finally {
      process.chdir(originalCwd);
      if (originalHomeSnap === undefined) delete process.env.ENIGMA_HOME;
      else process.env.ENIGMA_HOME = originalHomeSnap;
    }
  });

  it('..-containing ENIGMA_HOME: normalises to its realpath, mutateIndex succeeds', () => {
    // /tmp/foo/../bar normalises to /tmp/bar. Pre-fix the literal
    // string compare against `dir.startsWith(home)` failed; post-fix
    // the resolve+relative check accepts it.
    const realParent = mkdtempSync(join(tmpdir(), 'enigma-home-dotdot-parent-'));
    scratchHomes.push(realParent);
    // Build a child of a sibling so the `..` resolves to a real dir.
    const sibling = mkdtempSync(join(tmpdir(), 'enigma-home-dotdot-sibling-'));
    scratchHomes.push(sibling);
    // ENIGMA_HOME points through the parent + sibling via .. — when
    // resolved by `resolve()` it lands at `sibling`.
    process.env.ENIGMA_HOME = join(realParent, '..', basename(sibling));
    mutateIndex((current) => ({
      ...current,
      entries: [...current.entries, {
        name: 'PROBE_KEY',
        scope: 'global',
        depository: 'encrypted',
        ref: 'global/PROBE_KEY',
        createdAt: '2026-09-29T15:00:00.000Z',
        updatedAt: '2026-09-29T15:00:00.000Z',
      }],
    }));
    expect(existsSync(indexPath())).toBe(true);
    expect(readIndex().entries.map((e) => e.name)).toEqual(['PROBE_KEY']);
  });

  it('outside lock path whose parent dir does not yet exist: lock acquires successfully (round-2 fix item 1, last sub-bullet)', async () => {
    // Caller-owned path outside enigmaHome(). Pre-fix, ensureLockDir
    // refused to mkdir (it was scoped to "inside" and skipped). Post-fix
    // mkdir ALWAYS runs; mode tightening only inside.
    const home = freshHome('outside-creates');
    process.env.ENIGMA_HOME = home;
    // Construct a sibling scratch root for caller-owned lock files.
    const callerRoot = mkdtempSync(join(tmpdir(), 'enigma-caller-'));
    scratchHomes.push(callerRoot);
    // Pre-condition: the lock anchor's parent does NOT exist yet.
    const anchor = join(callerRoot, 'subdir-that-does-not-exist', 'lockfile');
    expect(existsSync(dirname(anchor))).toBe(false);
    // Acquire the lock — exercises the mkdir-always path for an
    // outside dir. Use a plain anchor path (not renderLockPath)
    // because renderLockPath's own contract requires the target's
    // parent to exist; here we're proving the GENERIC acquireFileLock
    // mkdir-always behaviour, which is what the spec calls out.
    const lock = acquireFileLock(anchor, 'outside probe');
    try {
      expect(existsSync(dirname(anchor))).toBe(true);
      expect(existsSync(anchor)).toBe(true);
      // Outside the home, a new dir gets the umask default, same as a
      // plain mkdirSync in the same place: not forced to 0700 (Kilo r4).
      const control = join(callerRoot, 'control');
      mkdirSync(control);
      expect(statSync(dirname(anchor)).mode & 0o777).toBe(statSync(control).mode & 0o777);
    } finally {
      lock.release();
    }
  });

  it('home/../outside is treated as outside (mode kept), even though the literal path starts with home', () => {
    // The lock path is passed UNNORMALIZED: `<home>/../<sibling>/caller-0755/lockfile`.
    // Its literal dirname starts with `<home>/`, so the pre-fix
    // `startsWith` check classified it as inside and chmod-ed the
    // caller's dir to 0700. resolve()+relative() sees it is outside.
    const home = freshHome('outside-via-dotdot');
    process.env.ENIGMA_HOME = home;
    const siblingRoot = mkdtempSync(join(tmpdir(), 'enigma-sibling-'));
    scratchHomes.push(siblingRoot);
    const callerDir = join(siblingRoot, 'caller-0755');
    mkdirSync(callerDir, { recursive: true, mode: 0o755 });
    chmodSync(callerDir, 0o755);
    const anchor = `${home}/../${basename(siblingRoot)}/caller-0755/lockfile`;
    expect(dirname(anchor).startsWith(`${home}/`)).toBe(true);

    const lock = acquireFileLock(anchor, 'outside-via-dotdot probe');
    try {
      expect(statSync(callerDir).mode & 0o777).toBe(0o755);
      expect(existsSync(join(callerDir, 'lockfile'))).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('trailing-slash ENIGMA_HOME: upsertTarget takes the ledger lock and persists (reviewer r2 B1 probe)', () => {
    const home = `${join(freshHome('ledger-trailing-slash'), 'home')}/`; // not created yet
    process.env.ENIGMA_HOME = home;
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: ['A'] });
    expect(existsSync(renderLedgerPath())).toBe(true);
    expect(readLedger().targets.map((x) => x.names)).toEqual([['A']]);
  });

  it('trailing-slash ENIGMA_HOME: a per-target locks/ anchor is created at 0700 and acquired', () => {
    const rawHome = freshHome('anchor-trailing-slash');
    process.env.ENIGMA_HOME = `${rawHome}/`;
    const worktree = mkdtempSync(join(tmpdir(), 'enigma-wt-'));
    scratchHomes.push(worktree);
    const target = join(worktree, '.env');
    writeFileSync(target, '');
    const anchor = renderLockPath(target);
    const lock = acquireFileLock(anchor);
    try {
      expect(existsSync(anchor)).toBe(true);
      expect(statSync(join(rawHome, 'locks')).mode & 0o777).toBe(0o700);
    } finally {
      lock.release();
    }
  });

  it('a symlink inside the home that escapes it does not get the outside dir chmod-ed (review r3)', () => {
    // `<home>/bridge -> <outside>`: lexically inside the home, really
    // outside. chmod follows symlinks, so containment must use realpaths.
    const home = freshHome('symlink-escape');
    process.env.ENIGMA_HOME = home;
    const outside = mkdtempSync(join(tmpdir(), 'enigma-outside-'));
    scratchHomes.push(outside);
    chmodSync(outside, 0o755);
    symlinkSync(outside, join(home, 'bridge'));

    const lock = acquireFileLock(join(home, 'bridge', 'anchor.lock'), 'symlink-escape probe');
    try {
      expect(statSync(outside).mode & 0o777).toBe(0o755);
      expect(existsSync(join(outside, 'anchor.lock'))).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('a symlinked ENIGMA_HOME (dotfiles setup) still gets its locks/ dir tightened to 0700', () => {
    const realHome = freshHome('symlinked-home-real');
    const linkRoot = mkdtempSync(join(tmpdir(), 'enigma-home-link-'));
    scratchHomes.push(linkRoot);
    const linkHome = join(linkRoot, 'home');
    symlinkSync(realHome, linkHome);
    process.env.ENIGMA_HOME = linkHome;
    mkdirSync(join(realHome, 'locks'), { mode: 0o755 });
    chmodSync(join(realHome, 'locks'), 0o755);

    const lock = acquireFileLock(join(linkHome, 'locks', 'x.lock'));
    try {
      expect(statSync(join(realHome, 'locks')).mode & 0o777).toBe(0o700);
    } finally {
      lock.release();
    }
  });

  it('a child dir whose name starts with ".." (e.g. "..x") is inside the home and is tightened', () => {
    const home = freshHome('dotdot-name');
    process.env.ENIGMA_HOME = home;
    const child = join(home, '..x');
    mkdirSync(child, { mode: 0o755 });
    chmodSync(child, 0o755);

    const lock = acquireFileLock(join(child, 'a.lock'));
    try {
      expect(statSync(child).mode & 0o777).toBe(0o700);
    } finally {
      lock.release();
    }
  });
});