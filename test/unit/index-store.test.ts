import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  LOCK_STALE_MS,
  buildRef,
  findIndexEntry,
  listIndexEntries,
  mutateIndex,
  readIndex,
  removeIndexEntry,
  resolveIndexEntry,
  upsertIndexEntry,
} from '../../src/core/index-store.js';
import type { IndexEntry, IndexFile } from '../../src/core/index-store.js';
import { indexLockPath, indexPath } from '../../src/core/paths.js';
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
    staleMs: LOCK_STALE_MS,
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
    staleMs: LOCK_STALE_MS,
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

  it('acquires and releases the lock — file exists during the delta and is gone after (Issue #66, AC #1)', () => {
    let observedDuringDelta: string | null = null;
    let observedMode: number | null = null;
    mutateIndex((cur) => {
      observedDuringDelta = readFileSync(indexLockPath(), 'utf8');
      observedMode = statSync(indexLockPath()).mode & 0o777;
      return upsertIndexEntry(cur, makeEntry());
    });

    expect(observedDuringDelta).not.toBeNull();
    // Three lines: token + pid + createdAtMs (a trailing \n yields a fourth
    // empty entry on split — verify the non-empty parts explicitly).
    const lines = observedDuringDelta!.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    // token: 32-char hex from randomBytes(16).
    expect(lines[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(Number.isFinite(Number(lines[1]))).toBe(true);
    expect(Number.isFinite(Number(lines[2]))).toBe(true);
    expect(Number(lines[1])).toBe(process.pid);

    // Lock file mode is 0600 (observed inside the critical section, before release).
    expect(observedMode).toBe(0o600);

    // Lock file is released after mutateIndex returns.
    expect(existsSync(indexLockPath())).toBe(false);
  });

  it('release() only unlinks the lock if it still carries our token — a lock a stale-break winner replaced under us is left alone (Issue #66 review)', () => {
    const lockPath = indexLockPath();
    let replacementBody = '';
    mutateIndex((cur) => {
      // Simulate a stale-break winner replacing our lock file with its own
      // (different-token) lock while we still believe we hold it. In
      // practice a *live* holder's lock can't be broken by anyone else —
      // the stale check requires it to look stale first — but this is
      // exactly the invariant the token check exists to protect: release()
      // must never remove a lock it does not own, however it got there.
      replacementBody = `deadbeefdeadbeefdeadbeefdeadbeef\n424242\n${Date.now()}\n`;
      writeFileSync(lockPath, replacementBody, { mode: 0o600 });
      return upsertIndexEntry(cur, makeEntry());
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(replacementBody);
  });

  it('releases the lock in finally even when the delta throws', () => {
    expect(() =>
      mutateIndex(() => {
        throw new Error('delta blew up');
      }),
    ).toThrowError(/delta blew up/);
    expect(existsSync(indexLockPath())).toBe(false);
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

  it('breaks a stale lock left by a crashed process and re-acquires (Issue #66, AC #3)', () => {
    // Plant a lock file whose recorded createdAtMs is well past the stale
    // threshold. Staleness is judged from the lock body's own content, not
    // filesystem mtime (see acquireIndexLock), so the body's third field is
    // what makes this lock look crashed-and-abandoned.
    const lockPath = indexLockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const staleCreatedAtMs = Date.now() - LOCK_STALE_MS - 5_000;
    writeFileSync(lockPath, `deadbeefdeadbeefdeadbeefdeadbeef\n99999\n${staleCreatedAtMs}\n`, { mode: 0o600 });

    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry()));

    expect(existsSync(lockPath)).toBe(false);
    const index = readIndex();
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.name).toBe('OPENAI_API_KEY');
  });

  it('does NOT break a fresh lock held by a live process (waits then times out)', () => {
    const lockPath = indexLockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    // Fresh (just-now) createdAtMs — must NOT be broken.
    writeFileSync(lockPath, `deadbeefdeadbeefdeadbeefdeadbeef\n99999\n${Date.now()}\n`, { mode: 0o600 });

    __setLockTimingForTesting({ staleMs: 60_000, retryIntervalMs: 5, maxAttempts: 3 });

    try {
      mutateIndex((cur) => cur);
      expect.unreachable('mutateIndex should have thrown E_LOCK_TIMEOUT');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_LOCK_TIMEOUT');
      expect((err as EnigmaError).message).toContain(lockPath);
    }

    // The fresh lock is still owned by the simulated peer.
    expect(existsSync(lockPath)).toBe(true);
  });

  it('throws E_LOCK_TIMEOUT after the bounded retry window, naming the lock file (Issue #66, AC #2)', () => {
    const lockPath = indexLockPath();
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    writeFileSync(lockPath, `deadbeefdeadbeefdeadbeefdeadbeef\n99999\n${Date.now()}\n`, { mode: 0o600 });

    __setLockTimingForTesting({ staleMs: 60_000, retryIntervalMs: 5, maxAttempts: 3 });

    try {
      mutateIndex((cur) => cur);
      expect.unreachable('mutateIndex should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_LOCK_TIMEOUT');
      expect((err as EnigmaError).message).toContain(lockPath);
    }
  });

  it('two consecutive mutateIndex calls serialize; both commits land (sanity)', () => {
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'A' })));
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'B' })));
    const names = readIndex().entries.map((e) => e.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('sequential simulation (NOT proof of interprocess exclusion — see manager.test.ts AC #6): two mutateIndex calls for different names, each re-reading inside its own lock, both entries survive', () => {
    // This is a SEQUENTIAL simulation of the AC's race, run entirely within
    // one process/one call stack — it proves mutateIndex's re-read-inside-
    // the-lock contract, not that two REAL concurrent processes actually
    // exclude each other (this test suite has no way to run genuinely
    // concurrent processes). The real lost-update regression coverage for
    // AC #6 lives at the `setSecret` level in manager.test.ts, which
    // exercises the actual async interleaving via a deferred depository
    // write (QA Low 5, PR #77 review).
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'NAME_A' })));
    mutateIndex((cur) => {
      // Inside A's second critical section, simulate "B already wrote NAME_B".
      const seed = upsertIndexEntry(cur, makeEntry({ name: 'NAME_B' }));
      // Then A adds its own entry on top — the order is reversed, but both names
      // are present because the names differ.
      return upsertIndexEntry(seed, makeEntry({ name: 'NAME_A' }));
    });

    const names = readIndex().entries.map((e) => e.name).sort();
    expect(names).toEqual(['NAME_A', 'NAME_B']);
  });

  it('sequential simulation (NOT proof of interprocess exclusion — see manager.test.ts AC #7): a remove interleaved with a set of a different name, both effects persist', () => {
    // Same caveat as the AC #6 test above: a sequential simulation of the
    // interleaving, not real interprocess concurrency. The real lost-update
    // coverage for AC #7 lives at the `deleteSecret`/`setSecret` level in
    // manager.test.ts (QA Low 5, PR #77 review).
    // Seed NAME_A, then mutate twice: first remove NAME_A, then set NAME_B.
    mutateIndex((cur) => upsertIndexEntry(cur, makeEntry({ name: 'NAME_A' })));

    mutateIndex((cur) => {
      // First, simulate a concurrent remove of NAME_A and a concurrent set of
      // NAME_B that landed between our initial reads and our lock acquire.
      const withoutA = { ...cur, entries: cur.entries.filter((e) => e.name !== 'NAME_A') };
      return upsertIndexEntry(withoutA, makeEntry({ name: 'NAME_B' }));
    });

    const names = readIndex().entries.map((e) => e.name).sort();
    expect(names).toEqual(['NAME_B']);
  });
});
