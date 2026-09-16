import { EnigmaError } from './errors.js';
import { indexPath } from './paths.js';
import { readJsonFile, writeJsonFileAtomic } from './secure-file.js';
import type { DepositoryId } from '../storage/interfaces.js';

export type Scope = 'project' | 'global';

export interface IndexEntry {
  name: string;
  scope: Scope;
  /** Present iff scope === 'project'. */
  projectId?: string;
  /** Present iff scope === 'project'; recorded in clear (D1.1). */
  projectPath?: string;
  depository: DepositoryId;
  ref: string;
  description?: string;
  usage?: 'interactive' | 'unattended';
  createdAt: string;
  updatedAt: string;
}

export interface IndexFile {
  version: 1;
  entries: IndexEntry[];
}

export interface IndexEntryView extends IndexEntry {
  /** True when a project entry of the same name shadows this global entry (D1.5). */
  shadowed?: boolean;
}

const EMPTY_INDEX: IndexFile = { version: 1, entries: [] };

/** ref convention (D1.9): "<scopeId>/<NAME>" for every depository except env, which uses the bare NAME. */
export function buildRef(name: string, scope: Scope, projectId?: string): string {
  return scope === 'global' ? `global/${name}` : `${projectId}/${name}`;
}

export function readIndex(): IndexFile {
  return readJsonFile(indexPath(), EMPTY_INDEX, 'E_INDEX_CORRUPT');
}

export function writeIndex(index: IndexFile): void {
  writeJsonFileAtomic(indexPath(), index);
}

function sameEntry(entry: IndexEntry, name: string, scope: Scope, projectId?: string): boolean {
  if (entry.name !== name || entry.scope !== scope) return false;
  return scope === 'global' ? true : entry.projectId === projectId;
}

export function findIndexEntry(
  index: IndexFile,
  name: string,
  scope: Scope,
  projectId?: string,
): IndexEntry | undefined {
  return index.entries.find((e) => sameEntry(e, name, scope, projectId));
}

/**
 * Finds the entry for `name` visible from `currentProjectId` when no explicit
 * scope is given: the project entry shadows the global one (D1.5).
 */
export function resolveIndexEntry(
  index: IndexFile,
  name: string,
  scope: Scope | undefined,
  currentProjectId: string | undefined,
): IndexEntry | undefined {
  if (scope) return findIndexEntry(index, name, scope, currentProjectId);
  const projectEntry = currentProjectId ? findIndexEntry(index, name, 'project', currentProjectId) : undefined;
  return projectEntry ?? findIndexEntry(index, name, 'global');
}

export function upsertIndexEntry(index: IndexFile, entry: IndexEntry): IndexFile {
  const others = index.entries.filter((e) => !sameEntry(e, entry.name, entry.scope, entry.projectId));
  return { ...index, entries: [...others, entry] };
}

/**
 * Removes the entry for `name`. When `scope` is omitted and both a project
 * (matching `currentProjectId`) and a global entry exist, throws
 * `E_AMBIGUOUS_SCOPE` (D1.5) instead of guessing.
 */
export function removeIndexEntry(
  index: IndexFile,
  name: string,
  scope: Scope | undefined,
  currentProjectId: string | undefined,
): { index: IndexFile; removed: IndexEntry } {
  if (!scope) {
    const projectEntry = currentProjectId ? findIndexEntry(index, name, 'project', currentProjectId) : undefined;
    const globalEntry = findIndexEntry(index, name, 'global');
    if (projectEntry && globalEntry) {
      throw new EnigmaError({
        code: 'E_AMBIGUOUS_SCOPE',
        message: `${name} exists in both project and global scope; specify --scope`,
        secretName: name,
      });
    }
  }
  const removed = resolveIndexEntry(index, name, scope, currentProjectId);
  if (!removed) {
    throw new EnigmaError({ code: 'E_NOT_FOUND', message: `${name} not found`, secretName: name });
  }
  const entries = index.entries.filter((e) => e !== removed);
  return { index: { ...index, entries }, removed };
}

export function listIndexEntries(
  index: IndexFile,
  opts: { scope?: Scope | 'all'; currentProjectId?: string } = {},
): IndexEntryView[] {
  const scope = opts.scope ?? 'all';
  const entries = scope === 'all' ? index.entries : index.entries.filter((e) => e.scope === scope);
  return entries.map((entry) => {
    if (entry.scope !== 'global') return { ...entry };
    const shadowedBy = opts.currentProjectId
      ? findIndexEntry(index, entry.name, 'project', opts.currentProjectId)
      : undefined;
    return { ...entry, shadowed: Boolean(shadowedBy) };
  });
}
