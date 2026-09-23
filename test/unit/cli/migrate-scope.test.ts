// Issue #72: `enigma migrate-scope` — index-only re-key of legacy
// project-scope entries to the canonical repo identity id.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdMigrateScope } from '../../../src/cli/commands/migrate-scope.js';
import { UsageError } from '../../../src/cli/args.js';
import { findIndexEntry, mutateIndex, readIndex, upsertIndexEntry } from '../../../src/core/index-store.js';
import type { IndexEntry } from '../../../src/core/index-store.js';
import { auditLogPath, indexPath } from '../../../src/core/paths.js';
import { projectId } from '../../../src/core/project.js';
import { listSecrets, setSecret } from '../../../src/storage/manager.js';
import { DEPOSITORY_MODULES } from '../../../src/storage/detect.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

/** What 0.2.0 recorded for a project entry: sha256(realpath(worktreeRoot))[:16]. */
function legacyProjectId(worktreeRoot: string): string {
  return createHash('sha256').update(realpathSync(worktreeRoot)).digest('hex').slice(0, 16);
}

/**
 * A real linked-worktree layout: `<wt>/.git` is a `gitdir:` file pointing at
 * `<repo>/.git/worktrees/<name>`, which carries `commondir: ../..` back to
 * `<repo>/.git`. `findRepoIdentityPath(wt)` therefore resolves to the repo —
 * the exact shape that produced legacy entries under 0.2.0.
 */
function makeLinkedWorktree(repoDir: string, name: string): string {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), `enigma-wt-${name}-`)));
  const gitdir = join(repoDir, '.git', 'worktrees', name);
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
  return wt;
}

function legacyEntry(overrides: Partial<IndexEntry> & Pick<IndexEntry, 'name' | 'projectId' | 'projectPath'>): IndexEntry {
  return {
    scope: 'project',
    depository: 'encrypted',
    ref: `${overrides.projectId}/${overrides.name}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function seed(entry: IndexEntry): void {
  mutateIndex((cur) => upsertIndexEntry(cur, entry));
}

function auditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditLogPath())) return [];
  return readFileSync(auditLogPath(), 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('cmdMigrateScope', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let repoDir: string;
  let originalCwd: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  const worktrees: string[] = [];

  function wt(name: string): string {
    const dir = makeLinkedWorktree(repoDir, name);
    worktrees.push(dir);
    return dir;
  }

  function output(): string {
    return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-repo-')));
    mkdirSync(join(repoDir, '.git'));
    originalCwd = process.cwd();
    process.chdir(repoDir);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    for (const dir of worktrees.splice(0)) rmSync(dir, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('dry run prints the classified plan and writes nothing — index bytes and audit log untouched', async () => {
    const wt1 = wt('one');
    seed(legacyEntry({ name: 'OLD_KEY', projectId: legacyProjectId(wt1), projectPath: wt1 }));
    const indexBefore = readFileSync(indexPath(), 'utf8');

    const code = await cmdMigrateScope([]);

    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('dry run');
    expect(out).toContain('OLD_KEY');
    expect(out).toContain('adoptable');
    expect(out).toContain('encrypted');
    expect(out).toContain(wt1);
    expect(out).toContain(`Target repo: ${repoDir}`);
    // No index write, no audit line — a dry run changes nothing.
    expect(readFileSync(indexPath(), 'utf8')).toBe(indexBefore);
    expect(auditLines()).toHaveLength(0);
  });

  it('--apply re-keys adoptable entries to the repo id; projectPath/ref unchanged; one migrate audit line per entry; visible from every worktree', async () => {
    const wt1 = wt('one');
    const wt2 = wt('two');
    const oldId = legacyProjectId(wt1);
    seed(legacyEntry({ name: 'OLD_KEY', projectId: oldId, projectPath: wt1 }));

    const code = await cmdMigrateScope(['--apply']);

    expect(code).toBe(0);
    const entry = findIndexEntry(readIndex(), 'OLD_KEY', 'project', projectId(repoDir));
    expect(entry).toBeDefined();
    expect(entry!.projectPath).toBe(wt1);
    expect(entry!.ref).toBe(`${oldId}/OLD_KEY`);
    // Visible from the repo root and every worktree of it.
    expect(listSecrets({ scope: 'project', cwd: repoDir }).map((e) => e.name)).toContain('OLD_KEY');
    expect(listSecrets({ scope: 'project', cwd: wt2 }).map((e) => e.name)).toContain('OLD_KEY');

    const migrate = auditLines().filter((l) => l.op === 'migrate');
    expect(migrate).toHaveLength(1);
    expect(migrate[0]).toMatchObject({ name: 'OLD_KEY', scope: 'project', depository: 'encrypted', actor: 'cli', ok: true, error: null });
  });

  it('a second --apply after a clean run is a no-op (re-runnable)', async () => {
    const wt1 = wt('one');
    seed(legacyEntry({ name: 'OLD_KEY', projectId: legacyProjectId(wt1), projectPath: wt1 }));
    await cmdMigrateScope(['--apply']);
    stdoutSpy.mockClear();

    const code = await cmdMigrateScope(['--apply']);
    expect(code).toBe(0);
    expect(output()).toContain('No legacy project-scope entries');
    expect(auditLines().filter((l) => l.op === 'migrate')).toHaveLength(1);
  });

  it('orphaned non-env entry: classified and left alone without --from (exit 1); re-keyed when --from names the recorded path', async () => {
    const gone = join(tmpdir(), 'enigma-gone-forever-path');
    seed(legacyEntry({ name: 'ORPHAN_KEY', projectId: 'deadbeef00000000', projectPath: gone, depository: 'keychain' }));

    // Dry run classifies it; --apply leaves it alone and signals incomplete.
    let code = await cmdMigrateScope([]);
    expect(code).toBe(0);
    expect(output()).toContain('orphaned-adoptable');
    expect(output()).toContain(`needs --from ${gone}`);

    stdoutSpy.mockClear();
    code = await cmdMigrateScope(['--apply']);
    expect(code).toBe(1);
    expect(findIndexEntry(readIndex(), 'ORPHAN_KEY', 'project', projectId(repoDir))).toBeUndefined();
    expect(auditLines().filter((l) => l.op === 'migrate')).toHaveLength(0);

    // --from attests membership: re-keyed on the next run.
    stdoutSpy.mockClear();
    code = await cmdMigrateScope(['--apply', '--from', gone]);
    expect(code).toBe(0);
    expect(findIndexEntry(readIndex(), 'ORPHAN_KEY', 'project', projectId(repoDir))).toMatchObject({
      projectPath: gone,
      depository: 'keychain',
    });
  });

  it('a --from that matches no recorded path is reported, not silently ignored', async () => {
    const gone = join(tmpdir(), 'enigma-gone-forever-path');
    seed(legacyEntry({ name: 'ORPHAN_KEY', projectId: 'deadbeef00000000', projectPath: gone, depository: 'keychain' }));

    const code = await cmdMigrateScope(['--from', join(tmpdir(), 'some-other-path')]);
    expect(code).toBe(0);
    expect(output()).toContain('matched no orphaned entry');
  });

  it('orphaned env entry is unrecoverable — never re-keyed even with --from; --prune-unrecoverable removes it with an audit remove', async () => {
    const gone = join(tmpdir(), 'enigma-gone-forever-path');
    seed(legacyEntry({ name: 'ENV_KEY', projectId: 'deadbeef00000000', projectPath: gone, depository: 'env', ref: 'ENV_KEY' }));

    let code = await cmdMigrateScope([]);
    expect(code).toBe(0);
    expect(output()).toContain('orphaned-unrecoverable');
    expect(output()).toContain('value is gone; re-request ENV_KEY');

    // Even attesting the path can't bring back a deleted .env — left alone.
    stdoutSpy.mockClear();
    code = await cmdMigrateScope(['--apply', '--from', gone]);
    expect(code).toBe(0);
    expect(findIndexEntry(readIndex(), 'ENV_KEY', 'project', projectId(repoDir))).toBeUndefined();
    expect(readIndex().entries.some((e) => e.name === 'ENV_KEY')).toBe(true);
    expect(auditLines().filter((l) => l.op === 'migrate')).toHaveLength(0);

    // Only --prune-unrecoverable removes the dangling entry, audited 'remove'.
    stdoutSpy.mockClear();
    code = await cmdMigrateScope(['--apply', '--prune-unrecoverable']);
    expect(code).toBe(0);
    expect(readIndex().entries.some((e) => e.name === 'ENV_KEY')).toBe(false);
    const removes = auditLines().filter((l) => l.op === 'remove');
    expect(removes).toHaveLength(1);
    expect(removes[0]).toMatchObject({ name: 'ENV_KEY', actor: 'cli', ok: true });
  });

  it('conflict: name exists at the repo id — skipped and named, exit 1; re-run after resolution succeeds', async () => {
    const wt1 = wt('one');
    seed(legacyEntry({ name: 'API_KEY', projectId: legacyProjectId(wt1), projectPath: wt1 }));
    seed(legacyEntry({ name: 'API_KEY', projectId: projectId(repoDir), projectPath: repoDir, ref: `${projectId(repoDir)}/API_KEY` }));

    const code = await cmdMigrateScope(['--apply']);
    expect(code).toBe(1);
    const out = output();
    expect(out).toContain('conflict');
    expect(out).toContain('API_KEY');
    // Never overwritten: the repo-id entry keeps its own ref, the legacy entry is untouched.
    expect(findIndexEntry(readIndex(), 'API_KEY', 'project', projectId(repoDir))!.ref).toBe(`${projectId(repoDir)}/API_KEY`);
    expect(readIndex().entries.filter((e) => e.name === 'API_KEY')).toHaveLength(2);
    expect(auditLines().filter((l) => l.op === 'migrate')).toHaveLength(0);

    // User resolves the conflict (removes the current-scope entry); re-run adopts.
    mutateIndex((cur) => ({ ...cur, entries: cur.entries.filter((e) => !(e.name === 'API_KEY' && e.projectId === projectId(repoDir))) }));
    stdoutSpy.mockClear();
    const code2 = await cmdMigrateScope(['--apply']);
    expect(code2).toBe(0);
    expect(readIndex().entries.filter((e) => e.name === 'API_KEY')).toHaveLength(1);
    expect(findIndexEntry(readIndex(), 'API_KEY', 'project', projectId(repoDir))).toBeDefined();
  });

  it('conflict: two legacy entries share a name — both skipped and named', async () => {
    const wt1 = wt('one');
    const wt2 = wt('two');
    seed(legacyEntry({ name: 'DUP_KEY', projectId: legacyProjectId(wt1), projectPath: wt1 }));
    seed(legacyEntry({ name: 'DUP_KEY', projectId: legacyProjectId(wt2), projectPath: wt2 }));

    const code = await cmdMigrateScope(['--apply']);
    expect(code).toBe(1);
    expect(readIndex().entries.filter((e) => e.name === 'DUP_KEY')).toHaveLength(2);
    expect(auditLines().filter((l) => l.op === 'migrate')).toHaveLength(0);
  });

  it('an entry whose projectPath belongs to a DIFFERENT repo is skipped entirely — not reported, not touched', async () => {
    const otherRepo = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-other-repo-')));
    mkdirSync(join(otherRepo, '.git'));
    try {
      seed(legacyEntry({ name: 'FOREIGN_KEY', projectId: projectId(otherRepo), projectPath: otherRepo }));

      const code = await cmdMigrateScope([]);
      expect(code).toBe(0);
      expect(output()).toContain('No legacy project-scope entries');
      expect(output()).not.toContain('FOREIGN_KEY');
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it('global-scope entries are never candidates', async () => {
    seed(legacyEntry({ name: 'GLOBAL_KEY', projectId: undefined, projectPath: undefined, scope: 'global', ref: 'global/GLOBAL_KEY' }));
    const code = await cmdMigrateScope([]);
    expect(code).toBe(0);
    expect(output()).toContain('No legacy project-scope entries');
  });

  it('calls no depository — every module factory and detect is spied and stays untouched during dry run AND --apply', async () => {
    const wt1 = wt('one');
    const gone = join(tmpdir(), 'enigma-gone-forever-path');
    seed(legacyEntry({ name: 'ADOPT_ME', projectId: legacyProjectId(wt1), projectPath: wt1 }));
    seed(legacyEntry({ name: 'ORPHAN_ME', projectId: 'deadbeef00000000', projectPath: gone, depository: 'keychain' }));
    seed(legacyEntry({ name: 'ENV_GONE', projectId: 'deadbeef00000000', projectPath: gone, depository: 'env', ref: 'ENV_GONE' }));

    const spies = DEPOSITORY_MODULES.flatMap((mod) => [
      vi.spyOn(mod, 'create'),
      vi.spyOn(mod, 'detect'),
    ]);
    try {
      await cmdMigrateScope([]);
      await cmdMigrateScope(['--apply', '--from', gone, '--prune-unrecoverable']);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('never prints or audits a secret value — sentinel value stored on disk stays out of every surface', async () => {
    // A real secret exists on disk; migration output must never carry it.
    await setSecret({ name: 'CURRENT_KEY', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: repoDir, actor: 'cli' });
    const wt1 = wt('one');
    seed(legacyEntry({ name: 'OLD_KEY', projectId: legacyProjectId(wt1), projectPath: wt1 }));

    await cmdMigrateScope([]);
    await cmdMigrateScope(['--apply']);

    const out = output() + stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(out).not.toContain(SENTINEL);
    expect(readFileSync(auditLogPath(), 'utf8')).not.toContain(SENTINEL);
    expect(readFileSync(indexPath(), 'utf8')).not.toContain(SENTINEL);
  });

  it('interleaved write simulation (NOT proof of interprocess exclusion — see test/integration/index-lock-kernel.test.ts): an entry committed by another writer between classification and the batch survives the migration', async () => {
    const wt1 = wt('one');
    seed(legacyEntry({ name: 'OLD_KEY', projectId: legacyProjectId(wt1), projectPath: wt1 }));
    // The plan the dry run computed is now stale: another writer commits a
    // new project entry before --apply takes the lock.
    await cmdMigrateScope([]);
    await setSecret({ name: 'CONCURRENT_KEY', value: 'v', scope: 'project', depository: 'encrypted', cwd: repoDir, actor: 'cli' });

    const code = await cmdMigrateScope(['--apply']);
    expect(code).toBe(0);
    // Both effects persist: the re-key AND the concurrent write — migrateScope
    // re-reads the index inside the lock and only touches classified entries.
    expect(findIndexEntry(readIndex(), 'OLD_KEY', 'project', projectId(repoDir))).toBeDefined();
    expect(findIndexEntry(readIndex(), 'CONCURRENT_KEY', 'project', projectId(repoDir))).toBeDefined();
  });

  it('an entry already at the repo id is not re-classified or double-migrated', async () => {
    const wt1 = wt('one');
    seed(legacyEntry({ name: 'OLD_KEY', projectId: legacyProjectId(wt1), projectPath: wt1 }));
    await cmdMigrateScope(['--apply']);
    const afterFirst = readIndex();
    stdoutSpy.mockClear();

    const code = await cmdMigrateScope(['--apply']);
    expect(code).toBe(0);
    expect(readIndex()).toEqual(afterFirst);
  });

  it('--help prints usage and exit-code semantics, exit 0', async () => {
    const code = await cmdMigrateScope(['--help']);
    expect(code).toBe(0);
    const out = output();
    expect(out).toContain('--from PATH');
    expect(out).toContain('--apply');
    expect(out).toContain('--prune-unrecoverable');
    expect(out).toContain('lexical');
  });

  it('rejects positional arguments and unknown flags as usage errors', async () => {
    await expect(cmdMigrateScope(['bogus-positional'])).rejects.toThrow(UsageError);
    await expect(cmdMigrateScope(['--bogus'])).rejects.toThrow(UsageError);
  });
});
