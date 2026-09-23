import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setLockTimingForTesting,
  LOCK_MAX_ATTEMPTS,
  LOCK_RETRY_INTERVAL_MS,
  buildRef,
  classifyLegacyScopeEntries,
  findIndexEntry,
  legacyScopeCountsLine,
  listIndexEntries,
  migrateScope,
  mutateIndex,
  readIndex,
  removeIndexEntry,
  resolveIndexEntry,
  upsertIndexEntry,
} from '../../src/core/index-store.js';
import type { IndexEntry, IndexFile } from '../../src/core/index-store.js';
import { indexLockPath, indexPath } from '../../src/core/paths.js';
import { projectId } from '../../src/core/project.js';
import { EnigmaError } from '../../src/core/errors.js';

function makeEntry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    name: 'OPENAI_API_KEY',
    scope: 'global',
    depository: 'encrypted',
    ref: 'global/OPENAI_API_KEY',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('index-store', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  // Saved so afterEach can restore, even if a test mutated the constants.
  const originalTimings = {
    retryIntervalMs: LOCK_RETRY_INTERVAL_MS,
    maxAttempts: LOCK_MAX_ATTEMPTS,
  };

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    __setLockTimingForTesting(originalTimings);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('buildRef uses "<scopeId>/<NAME>"', () => {
    expect(buildRef('OPENAI_API_KEY', 'global')).toBe('global/OPENAI_API_KEY');
    expect(buildRef('OPENAI_API_KEY', 'project', 'abc123')).toBe('abc123/OPENAI_API_KEY');
  });

  it('reads an empty index when the file does not exist', () => {
    expect(readIndex()).toEqual({ version: 1, entries: [] });
  });

  it('a corrupt index.json throws EnigmaError E_INDEX_CORRUPT, never a raw SyntaxError (A3)', () => {
    writeFileSync(indexPath(), '{ not valid json');

    try {
      readIndex();
      expect.unreachable('readIndex should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_INDEX_CORRUPT');
    }
  });

  it('mutateIndex writes index.json at mode 0600 (dir 0700) and never contains a value', () => {
    const index: IndexFile = upsertIndexEntry(readIndex(), makeEntry());
    mutateIndex(() => index);

    const mode = statSync(indexPath()).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(statSync(dirname(indexPath())).mode & 0o777).toBe(0o700);

    const raw = readFileSync(indexPath(), 'utf8');
    expect(raw).not.toContain('sk-sentinel-value-should-never-appear');
    expect(JSON.parse(raw)).toEqual(index);
  });

  it('upsertIndexEntry replaces an entry with the same name/scope/projectId', () => {
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ description: 'first' })));
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ description: 'second' })));

    const index = readIndex();
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.description).toBe('second');
  });

  it('keeps project-scoped entries with the same name independent per project', () => {
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' })));
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'project', projectId: 'proj-b', ref: 'proj-b/OPENAI_API_KEY' })));

    const index = readIndex();
    expect(index.entries).toHaveLength(2);
  });

  describe('scope resolution (D1.5)', () => {
    it('project entry shadows global for resolveIndexEntry when scope is omitted', () => {
      mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'global' })));
      mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' })));

      const resolved = resolveIndexEntry(readIndex(), 'OPENAI_API_KEY', undefined, 'proj-a');
      expect(resolved?.scope).toBe('project');
    });

    it('list marks the global entry shadowed when a matching project entry exists', () => {
      mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'global' })));
      mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' })));

      const views = listIndexEntries(readIndex(), { currentProjectId: 'proj-a' });
      const globalView = views.find((v) => v.scope === 'global');
      const projectView = views.find((v) => v.scope === 'project');

      expect(globalView?.shadowed).toBe(true);
      expect(projectView?.shadowed).toBeUndefined();
    });

    it('remove with both scopes present and no scope given throws E_AMBIGUOUS_SCOPE', () => {
      mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'global' })));
      mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' })));

      try {
        removeIndexEntry(readIndex(), 'OPENAI_API_KEY', undefined, 'proj-a');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EnigmaError);
        expect((err as EnigmaError).code).toBe('E_AMBIGUOUS_SCOPE');
      }
    });

    it('remove with an explicit scope succeeds even when both scopes are present', () => {
      mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'global' })));
      mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' })));

      const { index: updated, removed } = removeIndexEntry(readIndex(), 'OPENAI_API_KEY', 'global', 'proj-a');
      expect(removed.scope).toBe('global');
      expect(updated.entries).toHaveLength(1);
      expect(updated.entries[0]?.scope).toBe('project');
    });

    it('remove throws E_NOT_FOUND when the name does not exist', () => {
      expect(() => removeIndexEntry(readIndex(), 'MISSING', undefined, undefined)).toThrowError(
        expect.objectContaining({ code: 'E_NOT_FOUND' }),
      );
    });
  });

  it('findIndexEntry matches an exact scope', () => {
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry()));
    const index = readIndex();
    expect(findIndexEntry(index, 'OPENAI_API_KEY', 'global')).toBeDefined();
    expect(findIndexEntry(index, 'OPENAI_API_KEY', 'project', 'proj-a')).toBeUndefined();
  });
});

describe('index-store mutateIndex lock (Issue #66)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  const originalTimings = {
    retryIntervalMs: LOCK_RETRY_INTERVAL_MS,
    maxAttempts: LOCK_MAX_ATTEMPTS,
  };

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    __setLockTimingForTesting(originalTimings);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('anchor is created once and persists across release — release never unlinks (Issue #66, AC #1)', () => {
    let observedDuringDelta: string | null = null;
    let observedMode: number | null = null;
    mutateIndex((cur) => {
      observedDuringDelta = readFileSync(indexLockPath(), 'utf8');
      observedMode = statSync(indexLockPath()).mode & 0o777;
      return upsertIndexEntry(cur, makeEntry());
    });

    // Anchor survives release (kernel lock is what gets released).
    expect(existsSync(indexLockPath())).toBe(true);
    expect(observedMode).toBe(0o600);

    // Informational body only: pid + timestamp, never a value. Written
    // after the lock is held, never read for safety.
    const lines = observedDuringDelta!.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(Number(lines[0])).toBe(process.pid);
    expect(Number.isFinite(Number(lines[1]))).toBe(true);

    // The inode is stable across acquire/release cycles — the anchor is
    // never renamed, unlinked, or replaced.
    const ino = statSync(indexLockPath()).ino;
    for (let i = 0; i < 5; i++) mutateIndex((cur) => cur);
    expect(statSync(indexLockPath()).ino).toBe(ino);
    expect(existsSync(indexLockPath())).toBe(true);
  });

  it('a leftover empty/legacy body is irrelevant and gets rewritten (Issue #66, AC #3 area)', () => {
    // Simulate an anchor left behind by the removed name-based protocol or
    // a crash mid-metadata-write: garbage in, acquire still works, body is
    // rewritten — content is never consulted for safety.
    const lockPath = indexLockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, 'deadbeefdeadbeefdeadbeefdeadbeef\nnot-a-timestamp\n', { mode: 0o600 });

    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry()));

    const lines = readFileSync(lockPath, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(Number(lines[0])).toBe(process.pid);
    expect(readIndex().entries).toHaveLength(1);
  });

  it('a lock held by a live peer is waited out then times out — never evicted (Issue #66, AC #2)', async () => {
    const lockPath = indexLockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, '', { mode: 0o600 });

    // Hold the kernel lock through a second open description (flock is per
    // description, so this contends exactly like another process would).
    const { loadIndexLock } = await import('../../src/core/native-lock.js');
    const { openSync, closeSync } = await import('node:fs');
    const addon = loadIndexLock();
    const heldFd = openSync(lockPath, 'r+');
    expect(addon.tryLockSync(heldFd)).toBe(true);
    const heldIno = statSync(lockPath).ino;

    __setLockTimingForTesting({ retryIntervalMs: 5, maxAttempts: 3 });
    try {
      mutateIndex((cur) => cur);
      expect.unreachable('mutateIndex should have thrown E_LOCK_TIMEOUT');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_LOCK_TIMEOUT');
      expect((err as EnigmaError).message).toContain(lockPath);
    }

    // Never evicted: same inode, file untouched by the failed waiter.
    expect(statSync(lockPath).ino).toBe(heldIno);

    // Release the peer hold; the next acquire works immediately.
    addon.unlockSync(heldFd);
    closeSync(heldFd);
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry()));
    expect(readIndex().entries).toHaveLength(1);
  });

  it('releases the lock in finally even when the delta throws', () => {
    expect(() =>
      mutateIndex(() => {
        throw new Error('delta blew up');
      }),
    ).toThrowError(/delta blew up/);
    // The anchor persists but the kernel lock is free: a follow-up acquire
    // completes without waiting out the retry budget.
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'AFTER' })));
    expect(readIndex().entries.map((e) => e.name)).toEqual(['AFTER']);
  });

  it('does not write the index when the delta throws (lock cleanup, no partial commit)', () => {
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'SURVIVOR' })));
    const before = readFileSync(indexPath(), 'utf8');

    try {
      mutateIndex(() => {
        throw new Error('delta blew up');
      });
    } catch {
      // expected
    }

    // index.json unchanged — the failed delta did not commit.
    expect(readFileSync(indexPath(), 'utf8')).toBe(before);
  });

  it('repeated failing deltas do not leak fds (acquire closes on every path)', () => {
    const fdDir = existsSync('/proc/self/fd') ? '/proc/self/fd' : '/dev/fd';
    // Warm up lazy state (addon cache, first anchor create) before counting.
    mutateIndex((cur) => cur);

    const openFds = () => readdirSync(fdDir).length;
    const before = openFds();
    for (let i = 0; i < 40; i++) {
      try {
        mutateIndex(() => {
          throw new Error('delta blew up');
        });
      } catch {
        // expected
      }
    }
    for (let i = 0; i < 40; i++) mutateIndex((cur) => cur);
    expect(openFds()).toBe(before);
  });

  it('two consecutive mutateIndex calls serialize; both commits land (sanity)', () => {
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'A' })));
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'B' })));
    const names = readIndex().entries.map((e) => e.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('sequential simulation (NOT proof of interprocess exclusion — see the real-process suite in test/integration/index-lock-kernel.test.ts and manager.test.ts AC #6): two mutateIndex calls for different names, each re-reading inside its own lock, both entries survive', () => {
    // SEQUENTIAL simulation of the AC's race shape — proves mutateIndex's
    // re-read-inside-the-lock contract only. Real cross-process exclusion
    // is covered by test/integration/index-lock-kernel.test.ts (real
    // child processes); the real lost-update regression coverage for AC #6
    // lives at the `setSecret` level in manager.test.ts (QA Low 5).
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'NAME_A' })));
    mutateIndex((cur) => {
      const seed = upsertIndexEntry(cur, makeEntry({ name: 'NAME_B' }));
      return upsertIndexEntry(seed, makeEntry({ name: 'NAME_A' }));
    });

    const names = readIndex().entries.map((e) => e.name).sort();
    expect(names).toEqual(['NAME_A', 'NAME_B']);
  });

  it('sequential simulation (NOT proof of interprocess exclusion — see the real-process suite in test/integration/index-lock-kernel.test.ts and manager.test.ts AC #7): a remove interleaved with a set of a different name, both effects persist', () => {
    // Same caveat as the test above. Real lost-update coverage for AC #7
    // lives at the `deleteSecret`/`setSecret` level in manager.test.ts.
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'NAME_A' })));

    mutateIndex((cur) => {
      const withoutA = { ...cur, entries: cur.entries.filter((e) => e.name !== 'NAME_A') };
      return upsertIndexEntry(withoutA, makeEntry({ name: 'NAME_B' }));
    });

    const names = readIndex().entries.map((e) => e.name).sort();
    expect(names).toEqual(['NAME_B']);
  });
});

describe('scope migration (Issue #72)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let repoDir: string;
  const worktrees: string[] = [];

  function legacyProjectId(worktreeRoot: string): string {
    return createHash('sha256').update(realpathSync(worktreeRoot)).digest('hex').slice(0, 16);
  }

  function linkedWorktree(name: string): string {
    const wt = realpathSync(mkdtempSync(join(tmpdir(), `enigma-wt-${name}-`)));
    const gitdir = join(repoDir, '.git', 'worktrees', name);
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
    worktrees.push(wt);
    return wt;
  }

  function legacy(overrides: Partial<IndexEntry> & Pick<IndexEntry, 'name'>): IndexEntry {
    return makeEntry({
      scope: 'project',
      depository: 'encrypted',
      ref: `${overrides.projectId}/${overrides.name}`,
      ...overrides,
    });
  }

  function seed(entry: IndexEntry): void {
    mutateIndex((cur) => upsertIndexEntry(cur, entry));
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-repo-')));
    mkdirSync(join(repoDir, '.git'));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    for (const dir of worktrees.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('classifies a worktree-written entry as adoptable — path exists and resolves to this repo', () => {
    const wt = linkedWorktree('one');
    seed(legacy({ name: 'OLD_KEY', projectId: legacyProjectId(wt), projectPath: wt }));

    const report = classifyLegacyScopeEntries(readIndex(), { cwd: repoDir });
    expect(report.projectId).toBe(projectId(repoDir));
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ class: 'adoptable', rekeyable: true });
    expect(report.counts).toEqual({ adoptable: 1, 'orphaned-adoptable': 0, 'orphaned-unrecoverable': 0, conflict: 0 });
  });

  it('classifies a dead-path non-env entry as orphaned-adoptable; --from attests it into the re-key pool', () => {
    const gone = join(tmpdir(), 'enigma-dead-path-nope');
    seed(legacy({ name: 'ORPHAN', projectId: 'deadbeef00000000', projectPath: gone, depository: 'keychain' }));

    const without = classifyLegacyScopeEntries(readIndex(), { cwd: repoDir });
    expect(without.items[0]).toMatchObject({ class: 'orphaned-adoptable', rekeyable: false });

    const attested = classifyLegacyScopeEntries(readIndex(), { cwd: repoDir, from: gone });
    expect(attested.items[0]).toMatchObject({ class: 'orphaned-adoptable', rekeyable: true });
  });

  it('classifies a dead-path env entry as orphaned-unrecoverable — --from cannot rescue it', () => {
    const gone = join(tmpdir(), 'enigma-dead-path-nope');
    seed(legacy({ name: 'ENV_GONE', projectId: 'deadbeef00000000', projectPath: gone, depository: 'env', ref: 'ENV_GONE' }));

    const report = classifyLegacyScopeEntries(readIndex(), { cwd: repoDir, from: gone });
    expect(report.items[0]).toMatchObject({ class: 'orphaned-unrecoverable', rekeyable: false });
    expect(report.items[0]?.detail).toContain('re-request ENV_GONE');
  });

  it('classifies a name already at the repo id, and two legacy entries sharing a name, as conflicts', () => {
    const wt1 = linkedWorktree('one');
    const wt2 = linkedWorktree('two');
    seed(legacy({ name: 'TAKEN', projectId: projectId(repoDir), projectPath: repoDir }));
    seed(legacy({ name: 'TAKEN', projectId: legacyProjectId(wt1), projectPath: wt1 }));
    seed(legacy({ name: 'DUP', projectId: legacyProjectId(wt1), projectPath: wt1 }));
    seed(legacy({ name: 'DUP', projectId: legacyProjectId(wt2), projectPath: wt2 }));

    const report = classifyLegacyScopeEntries(readIndex(), { cwd: repoDir });
    expect(report.counts.conflict).toBe(3);
    expect(report.items.every((i) => i.class === 'conflict' && !i.rekeyable)).toBe(true);
  });

  it('skips entries already at the repo id, global entries, and entries belonging to other repos', () => {
    const otherRepo = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-other-repo-')));
    mkdirSync(join(otherRepo, '.git'));
    try {
      seed(legacy({ name: 'CURRENT', projectId: projectId(repoDir), projectPath: repoDir }));
      seed(legacy({ name: 'GLOBAL', scope: 'global', projectId: undefined, projectPath: undefined }));
      seed(legacy({ name: 'FOREIGN', projectId: projectId(otherRepo), projectPath: otherRepo }));

      const report = classifyLegacyScopeEntries(readIndex(), { cwd: repoDir });
      expect(report.items).toHaveLength(0);
      expect(legacyScopeCountsLine(report)).toBeNull();
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it('migrateScope re-keys only classified entries — projectPath/ref preserved, other entries untouched', () => {
    const wt = linkedWorktree('one');
    const oldId = legacyProjectId(wt);
    seed(legacy({ name: 'OLD', projectId: oldId, projectPath: wt }));
    seed(legacy({ name: 'KEEP', projectId: projectId(repoDir), projectPath: repoDir, ref: `${projectId(repoDir)}/KEEP` }));

    const result = migrateScope({ cwd: repoDir });
    expect(result.rekeyed.map((e) => e.name)).toEqual(['OLD']);
    expect(result.rekeyed[0]).toMatchObject({ projectId: projectId(repoDir), projectPath: wt, ref: `${oldId}/OLD` });

    const after = readIndex();
    expect(findIndexEntry(after, 'OLD', 'project', projectId(repoDir))).toBeDefined();
    expect(findIndexEntry(after, 'KEEP', 'project', projectId(repoDir))).toBeDefined();
    expect(after.entries).toHaveLength(2);
  });

  it('migrateScope prunes unrecoverable entries only with pruneUnrecoverable', () => {
    const gone = join(tmpdir(), 'enigma-dead-path-nope');
    seed(legacy({ name: 'ENV_GONE', projectId: 'deadbeef00000000', projectPath: gone, depository: 'env', ref: 'ENV_GONE' }));

    const kept = migrateScope({ cwd: repoDir });
    expect(kept.unrecoverable.map((e) => e.name)).toEqual(['ENV_GONE']);
    expect(kept.pruned).toHaveLength(0);
    expect(readIndex().entries).toHaveLength(1);

    const pruned = migrateScope({ cwd: repoDir, pruneUnrecoverable: true });
    expect(pruned.pruned.map((e) => e.name)).toEqual(['ENV_GONE']);
    expect(readIndex().entries).toHaveLength(0);
  });

  it('migrateScope reports leftover conflicts and unadopted orphans, and re-keys --from-attested orphans', () => {
    const gone = join(tmpdir(), 'enigma-dead-path-nope');
    seed(legacy({ name: 'ORPHAN', projectId: 'deadbeef00000000', projectPath: gone, depository: 'keychain' }));

    const noFrom = migrateScope({ cwd: repoDir });
    expect(noFrom.pendingOrphans.map((e) => e.name)).toEqual(['ORPHAN']);
    expect(noFrom.rekeyed).toHaveLength(0);

    const withFrom = migrateScope({ cwd: repoDir, from: gone });
    expect(withFrom.rekeyed.map((e) => e.name)).toEqual(['ORPHAN']);
    expect(findIndexEntry(readIndex(), 'ORPHAN', 'project', projectId(repoDir))).toBeDefined();
  });

  it('legacyScopeCountsLine carries per-class counts and the exact command — never a value', () => {
    const wt = linkedWorktree('one');
    seed(legacy({ name: 'OLD_KEY', projectId: legacyProjectId(wt), projectPath: wt }));
    const report = classifyLegacyScopeEntries(readIndex(), { cwd: repoDir });

    const line = legacyScopeCountsLine(report);
    expect(line).toContain('1 adoptable');
    expect(line).toContain('enigma migrate-scope');
    expect(line).toContain('--apply');
  });
});
