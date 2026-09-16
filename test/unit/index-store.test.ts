import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRef,
  findIndexEntry,
  listIndexEntries,
  readIndex,
  removeIndexEntry,
  resolveIndexEntry,
  upsertIndexEntry,
  writeIndex,
} from '../../src/core/index-store.js';
import type { IndexEntry } from '../../src/core/index-store.js';
import { indexPath } from '../../src/core/paths.js';
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

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
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

  it('writes index.json at mode 0600 (dir 0700) and never contains a value', () => {
    const index = upsertIndexEntry(readIndex(), makeEntry());
    writeIndex(index);

    const mode = statSync(indexPath()).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(statSync(dirname(indexPath())).mode & 0o777).toBe(0o700);

    const raw = readFileSync(indexPath(), 'utf8');
    expect(raw).not.toContain('sk-sentinel-value-should-never-appear');
    expect(JSON.parse(raw)).toEqual(index);
  });

  it('upsertIndexEntry replaces an entry with the same name/scope/projectId', () => {
    let index = readIndex();
    index = upsertIndexEntry(index, makeEntry({ description: 'first' }));
    index = upsertIndexEntry(index, makeEntry({ description: 'second' }));

    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.description).toBe('second');
  });

  it('keeps project-scoped entries with the same name independent per project', () => {
    let index = readIndex();
    index = upsertIndexEntry(index, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' }));
    index = upsertIndexEntry(index, makeEntry({ scope: 'project', projectId: 'proj-b', ref: 'proj-b/OPENAI_API_KEY' }));

    expect(index.entries).toHaveLength(2);
  });

  describe('scope resolution (D1.5)', () => {
    it('project entry shadows global for resolveIndexEntry when scope is omitted', () => {
      let index = readIndex();
      index = upsertIndexEntry(index, makeEntry({ scope: 'global' }));
      index = upsertIndexEntry(index, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' }));

      const resolved = resolveIndexEntry(index, 'OPENAI_API_KEY', undefined, 'proj-a');
      expect(resolved?.scope).toBe('project');
    });

    it('list marks the global entry shadowed when a matching project entry exists', () => {
      let index = readIndex();
      index = upsertIndexEntry(index, makeEntry({ scope: 'global' }));
      index = upsertIndexEntry(index, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' }));

      const views = listIndexEntries(index, { currentProjectId: 'proj-a' });
      const globalView = views.find((v) => v.scope === 'global');
      const projectView = views.find((v) => v.scope === 'project');

      expect(globalView?.shadowed).toBe(true);
      expect(projectView?.shadowed).toBeUndefined();
    });

    it('remove with both scopes present and no scope given throws E_AMBIGUOUS_SCOPE', () => {
      let index = readIndex();
      index = upsertIndexEntry(index, makeEntry({ scope: 'global' }));
      index = upsertIndexEntry(index, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' }));

      try {
        removeIndexEntry(index, 'OPENAI_API_KEY', undefined, 'proj-a');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EnigmaError);
        expect((err as EnigmaError).code).toBe('E_AMBIGUOUS_SCOPE');
      }
    });

    it('remove with an explicit scope succeeds even when both scopes are present', () => {
      let index = readIndex();
      index = upsertIndexEntry(index, makeEntry({ scope: 'global' }));
      index = upsertIndexEntry(index, makeEntry({ scope: 'project', projectId: 'proj-a', ref: 'proj-a/OPENAI_API_KEY' }));

      const { index: updated, removed } = removeIndexEntry(index, 'OPENAI_API_KEY', 'global', 'proj-a');
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
    const index = upsertIndexEntry(readIndex(), makeEntry());
    expect(findIndexEntry(index, 'OPENAI_API_KEY', 'global')).toBeDefined();
    expect(findIndexEntry(index, 'OPENAI_API_KEY', 'project', 'proj-a')).toBeUndefined();
  });
});
