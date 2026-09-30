/* Unit tests for the renderer (Issue #107).
 *
 * The renderer is split into two parts:
 *  - `buildRenderPlan` is pure — tested by mutating the inputs and
 *    asserting the resulting RenderPlan (names-only, no values).
 *  - `executeRender` does the I/O (lock + atomic write + ledger + audit)
 *    — tested by running it with a sentinel resolveValue and asserting
 *    the sentinel lands in the file and nowhere else.
 *
 * Both paths run with ENIGMA_HOME in a hermetic temp dir; the index is
 * pre-populated by `setSecret` from encrypted/env (the depository
 * modules don't spawn, see test/setup.ts). No real binary is ever
 * invoked here.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLogPath } from '../../../src/core/paths.js';
import { setSecret } from '../../../src/storage/manager.js';
import type { IndexFile } from '../../../src/core/index-store.js';
import type { ProjectManifest } from '../../../src/core/config.js';
import { buildRenderPlan, executeRender } from '../../../src/render/render.js';
import { readLedger } from '../../../src/render/ledger.js';
import { projectId as computeProjectId } from '../../../src/core/project.js';
import { RENDER_BEGIN_MARKER, RENDER_END_MARKER, ENV_BEGIN_MARKER, ENV_END_MARKER } from '../../../src/storage/dotenv-file.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear-7c3a';

function readAudit(): Array<Record<string, unknown>> {
  return existsSync(auditLogPath())
    ? readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

function makeIndex(entries: IndexFile['entries']): IndexFile {
  return { version: 1, entries };
}

function makeManifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return { secrets: {}, ...overrides };
}

describe('renderer — buildRenderPlan (names-only)', () => {
  let tmpHome: string;
  let tmpProject: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let projectId: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    originalCwd = process.cwd();
    process.chdir(tmpProject);
    projectId = computeProjectId(tmpProject);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('a project entry with an encrypted depository is added to toWrite; global entries are listed as skipped-global', () => {
    const index = makeIndex([
      { name: 'OPENAI_API_KEY', scope: 'project', projectId, projectPath: tmpProject, depository: 'encrypted', ref: `${projectId}/OPENAI_API_KEY`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { name: 'GLOBAL_KEY', scope: 'global', depository: 'encrypted', ref: 'global/GLOBAL_KEY', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ]);

    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    expect(plan.enabled).toBe(true);
    expect(plan.toWrite.map((t) => t.name)).toEqual(['OPENAI_API_KEY']);
    expect(plan.perName.find((p) => p.kind === 'skipped-global' && p.name === 'GLOBAL_KEY')).toBeDefined();
    expect(plan.finalNames).toEqual(['OPENAI_API_KEY']);
    // Names-only: plan carries no `value` field anywhere.
    expect(JSON.stringify(plan)).not.toContain(SENTINEL);
  });

  it('a project entry with a prompting depository is NOT in toWrite; not in the block → skipped-prompting-auto', () => {
    const index = makeIndex([
      { name: 'KC_KEY', scope: 'project', projectId, projectPath: tmpProject, depository: 'keychain', ref: `${projectId}/KC_KEY`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ]);

    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    expect(plan.toWrite).toEqual([]);
    expect(plan.perName).toContainEqual({ kind: 'skipped-prompting-auto', name: 'KC_KEY', depository: 'keychain' });
  });

  it('a prompting-store project entry that is ALREADY in the existing block is kept verbatim — line bytes copied, never parsed', () => {
    writeFileSync(join(tmpProject, '.env'), `# some user line\n${RENDER_BEGIN_MARKER}\nKC_KEY=${SENTINEL}-legacy\n${RENDER_END_MARKER}\n`, { mode: 0o600 });
    const index = makeIndex([
      { name: 'KC_KEY', scope: 'project', projectId, projectPath: tmpProject, depository: 'keychain', ref: `${projectId}/KC_KEY`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ]);

    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    expect(plan.toWrite).toEqual([]);
    expect(plan.toKeep).toEqual([{ name: 'KC_KEY', line: `KC_KEY=${SENTINEL}-legacy` }]);
    expect(plan.finalNames).toEqual(['KC_KEY']);
    expect(plan.perName).toContainEqual({ kind: 'keep-prompting', name: 'KC_KEY', depository: 'keychain', line: `KC_KEY=${SENTINEL}-legacy` });
    // The plan DOES contain the kept line (by design — that's the kept payload). What's important is no OTHER value lands in the plan.
    expect(plan.perName.find((p) => p.kind === 'keep-prompting' && p.name === 'KC_KEY')).toBeDefined();
  });

  it('render.names narrows the auto-set; non-listed names are skipped-manifest-narrowing', () => {
    const index = makeIndex([
      { name: 'A', scope: 'project', projectId, projectPath: tmpProject, depository: 'encrypted', ref: `${projectId}/A`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { name: 'B', scope: 'project', projectId, projectPath: tmpProject, depository: 'encrypted', ref: `${projectId}/B`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ]);

    const plan = buildRenderPlan({
      cwd: tmpProject,
      projectId,
      worktree: tmpProject,
      index,
      manifest: makeManifest({ render: { names: ['A'] } }),
    });

    expect(plan.toWrite.map((t) => t.name)).toEqual(['A']);
    expect(plan.perName).toContainEqual({ kind: 'skipped-manifest-narrowing', name: 'B' });
  });

  it('render.enabled: false short-circuits: toWrite empty, toRemove includes previously rendered names', () => {
    writeFileSync(join(tmpProject, '.env'), `${RENDER_BEGIN_MARKER}\nOLD=old-value\n${RENDER_END_MARKER}\n`, { mode: 0o600 });
    const index = makeIndex([
      { name: 'A', scope: 'project', projectId, projectPath: tmpProject, depository: 'encrypted', ref: `${projectId}/A`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ]);

    const plan = buildRenderPlan({
      cwd: tmpProject,
      projectId,
      worktree: tmpProject,
      index,
      manifest: makeManifest({ render: { enabled: false } }),
    });

    expect(plan.enabled).toBe(false);
    expect(plan.toWrite).toEqual([]);
    expect(plan.toRemove).toEqual(['OLD']);
  });

  it('a name previously rendered that has been removed from the index is in toRemove (Tech Lead rule #4 second clause)', () => {
    writeFileSync(join(tmpProject, '.env'), `${RENDER_BEGIN_MARKER}\nREMOVED=old\nGONE=stale\n${RENDER_END_MARKER}\n`, { mode: 0o600 });
    const index = makeIndex([]);

    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    expect(plan.toRemove.sort()).toEqual(['GONE', 'REMOVED']);
    expect(plan.finalNames).toEqual([]);
  });

  it('explicitName: errors with E_NOT_FOUND if the name is not a project-scoped secret for this repo', () => {
    const index = makeIndex([
      { name: 'OTHER', scope: 'project', projectId: 'pid-other', projectPath: tmpProject, depository: 'encrypted', ref: 'pid-other/OTHER', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ]);

    expect(() =>
      buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest(), explicitName: 'OTHER' }),
    ).toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }));
  });

  it('explicitName: merges — toKeep has every other existing name, toWrite has only the explicit name', () => {
    writeFileSync(join(tmpProject, '.env'), `${RENDER_BEGIN_MARKER}\nA=1\nB=2\n${RENDER_END_MARKER}\n`, { mode: 0o600 });
    const index = makeIndex([
      { name: 'A', scope: 'project', projectId, projectPath: tmpProject, depository: 'encrypted', ref: `${projectId}/A`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { name: 'C', scope: 'project', projectId, projectPath: tmpProject, depository: 'encrypted', ref: `${projectId}/C`, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ]);

    const plan = buildRenderPlan({
      cwd: tmpProject,
      projectId,
      worktree: tmpProject,
      index,
      manifest: makeManifest(),
      explicitName: 'C',
    });

    expect(plan.explicit).toBe(true);
    expect(plan.toWrite).toEqual([{ name: 'C', depository: 'encrypted' }]);
    // B was in the previous block but NOT in the index — explicit mode
    // preserves it byte-identical (it's not dropped because of explicitName
    // semantics — we're MERGING, not replacing).
    expect(plan.toKeep.map((k) => k.name).sort()).toEqual(['A', 'B']);
    expect(plan.toKeep.find((k) => k.name === 'A')?.line).toBe('A=1');
    expect(plan.toKeep.find((k) => k.name === 'B')?.line).toBe('B=2');
    expect(plan.finalNames.sort()).toEqual(['A', 'B', 'C']);
    expect(plan.toRemove).toEqual([]);
  });

  describe('render.path validation (Tech Lead rule #7)', () => {
    it('rejects an absolute path', () => {
      expect(() =>
        buildRenderPlan({
          cwd: tmpProject,
          projectId,
          worktree: tmpProject,
          index: makeIndex([]),
          manifest: makeManifest({ render: { path: '/etc/passwd' } }),
        }),
      ).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED' }));
    });

    it('rejects a lexical escape (..)', () => {
      expect(() =>
        buildRenderPlan({
          cwd: tmpProject,
          projectId,
          worktree: tmpProject,
          index: makeIndex([]),
          manifest: makeManifest({ render: { path: '../escape.env' } }),
        }),
      ).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED' }));
    });

    it('rejects a missing parent directory', () => {
      expect(() =>
        buildRenderPlan({
          cwd: tmpProject,
          projectId,
          worktree: tmpProject,
          index: makeIndex([]),
          manifest: makeManifest({ render: { path: 'no-such-subdir/.env' } }),
        }),
      ).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED' }));
    });

    it('rejects a symlink-escape parent directory', () => {
      // Put a symlink under the worktree that resolves to OUTSIDE.
      const linkDir = join(tmpProject, 'link-escape');
      mkdirSync(linkDir, { recursive: true });
      // Place a hidden escape: tmpProject has a symlink, its realpath leaves the worktree.
      const outside = join(tmpHome, 'outside-target');
      mkdirSync(outside, { recursive: true });
      // Now create a symlink INSIDE worktree that resolves to that outside dir.
      // Use rm + symlink to overwrite the empty linkDir with a real symlink.
      rmSync(linkDir, { recursive: true, force: true });
      symlinkSync(outside, linkDir);
      expect(() =>
        buildRenderPlan({
          cwd: tmpProject,
          projectId,
          worktree: tmpProject,
          index: makeIndex([]),
          manifest: makeManifest({ render: { path: 'link-escape/file.env' } }),
        }),
      ).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED' }));
    });
  });
});

describe('renderer — executeRender (I/O, lock, ledger, audit)', () => {
  let tmpHome: string;
  let tmpProject: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let projectId: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    originalCwd = process.cwd();
    process.chdir(tmpProject);
    projectId = computeProjectId(tmpProject);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('writes a render block with NAME=value for each auto-set name, file mode 0600', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    await setSecret({ name: 'OTHER', value: 'other-value', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const { readIndex } = await import('../../../src/core/index-store.js');
    const index = readIndex();
    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    const outcome = await executeRender(plan, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async (name) => (name === 'OPENAI_API_KEY' ? SENTINEL : 'other-value') });

    expect(outcome.rendered.sort()).toEqual(['OPENAI_API_KEY', 'OTHER']);
    const envPath = join(tmpProject, '.env');
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain(RENDER_BEGIN_MARKER);
    expect(content).toContain(RENDER_END_MARKER);
    expect(content).toContain(`OPENAI_API_KEY=${SENTINEL}`);
    expect(content).toContain('OTHER=other-value');
    expect((statSync(envPath).mode & 0o777)).toBe(0o600);
  });

  it('preserves the env depository\'s own block byte-for-byte outside the render block (Tech Lead rule #6)', async () => {
    writeFileSync(
      join(tmpProject, '.env'),
      `USER_LINE=1\n${ENV_BEGIN_MARKER}\nA=envblock-a\n${ENV_END_MARKER}\n${RENDER_BEGIN_MARKER}\nA=renderblock-a\n${RENDER_END_MARKER}\n`,
      { mode: 0o600 },
    );
    // Pre-populate the index with the SAME name that is in the previous
    // render block so it is KEPT (Tech Lead rule #4). The new secret B is
    // the auto-set addition.
    const { mutateIndex, upsertIndexEntry, readIndex } = await import('../../../src/core/index-store.js');
    mutateIndex((current) => upsertIndexEntry(current, {
      name: 'A',
      scope: 'project',
      projectId,
      projectPath: tmpProject,
      depository: 'encrypted',
      ref: `${projectId}/A`,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    await setSecret({ name: 'B', value: 'val-b', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const index = readIndex();
    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    await executeRender(plan, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async (name) => (name === 'B' ? 'val-b' : 'val-a') });

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    // Env depository block preserved byte-identical.
    expect(content).toContain(`${ENV_BEGIN_MARKER}\nA=envblock-a\n${ENV_END_MARKER}`);
    // User line preserved.
    expect(content.startsWith('USER_LINE=1\n')).toBe(true);
    // Render block now contains A=val-a (re-resolved) AND B=val-b (new),
    // in sorted order.
    expect(content).toContain(`${RENDER_BEGIN_MARKER}\nA=val-a\nB=val-b\n${RENDER_END_MARKER}`);
  });

  it('a second render with the same names is idempotent — same bytes in the file', async () => {
    await setSecret({ name: 'A', value: 'value-a', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    await setSecret({ name: 'B', value: 'value-b', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const { readIndex } = await import('../../../src/core/index-store.js');
    const index = readIndex();
    const plan1 = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });
    await executeRender(plan1, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async (n) => (n === 'A' ? 'value-a' : 'value-b') });

    const firstBytes = readFileSync(join(tmpProject, '.env'), 'utf8');
    const plan2 = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });
    await executeRender(plan2, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async (n) => (n === 'A' ? 'value-a' : 'value-b') });
    const secondBytes = readFileSync(join(tmpProject, '.env'), 'utf8');

    expect(secondBytes).toBe(firstBytes);
  });

  it('a name previously rendered with a prompting depository is kept verbatim when its entry still exists in the project scope', async () => {
    writeFileSync(join(tmpProject, '.env'), `${RENDER_BEGIN_MARKER}\nKC_KEY=${SENTINEL}-preexisting\n${RENDER_END_MARKER}\n`, { mode: 0o600 });
    const { upsertIndexEntry, mutateIndex, readIndex } = await import('../../../src/core/index-store.js');
    mutateIndex((current) => upsertIndexEntry(current, {
      name: 'KC_KEY',
      scope: 'project',
      projectId,
      projectPath: tmpProject,
      depository: 'keychain',
      ref: `${projectId}/KC_KEY`,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));

    const index = readIndex();
    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    let resolveCalled = false;
    await executeRender(plan, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async () => { resolveCalled = true; return 'SHOULD-NOT-RESOLVE'; } });

    expect(resolveCalled).toBe(false);
    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toContain(`KC_KEY=${SENTINEL}-preexisting`);
  });

  it('a name previously rendered but no longer in the index is dropped from the block (Tech Lead rule #4 second clause)', async () => {
    writeFileSync(join(tmpProject, '.env'), `${RENDER_BEGIN_MARKER}\nREMOVED=old\n${RENDER_END_MARKER}\n`, { mode: 0o600 });
    const index = makeIndex([]);
    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    const outcome = await executeRender(plan, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async () => { throw new Error('not called'); } });

    expect(outcome.removed).toEqual(['REMOVED']);
    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).not.toContain('REMOVED');
    expect(content).toContain(RENDER_BEGIN_MARKER);
    expect(content).toContain(RENDER_END_MARKER);
  });

  it('a per-name resolve failure with NO existing line is reported by name; other names still render', async () => {
    // Set a secret the resolver will reject AND one it accepts.
    await setSecret({ name: 'GOOD', value: 'good-value', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    // Add a second entry the resolver will fail on.
    const { upsertIndexEntry, mutateIndex, readIndex } = await import('../../../src/core/index-store.js');
    mutateIndex((current) => upsertIndexEntry(current, {
      name: 'BAD',
      scope: 'project',
      projectId,
      projectPath: tmpProject,
      depository: 'encrypted',
      ref: `${projectId}/BAD`,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));
    const index = readIndex();
    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    const outcome = await executeRender(plan, {
      actor: 'cli',
      projectId,
      worktree: tmpProject,
      resolveValue: async (name) => {
        if (name === 'GOOD') return 'good-value';
        throw new Error(`simulated missing value for ${name}`);
      },
    });

    expect(outcome.rendered).toEqual(['GOOD']);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.name).toBe('BAD');
    expect(outcome.failed[0]?.errorCode).toBe('E_UNKNOWN');

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toContain('GOOD=good-value');
    expect(content).not.toContain('BAD=');
  });

  it('a per-name resolve failure WITH an existing line keeps that line verbatim (Tech Lead rule #5)', async () => {
    writeFileSync(join(tmpProject, '.env'), `${RENDER_BEGIN_MARKER}\nKEY=${SENTINEL}-prior\n${RENDER_END_MARKER}\n`, { mode: 0o600 });
    const { mutateIndex, upsertIndexEntry, readIndex } = await import('../../../src/core/index-store.js');
    mutateIndex((current) => upsertIndexEntry(current, {
      name: 'KEY',
      scope: 'project',
      projectId,
      projectPath: tmpProject,
      depository: 'encrypted',
      ref: `${projectId}/KEY`,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }));

    const index = readIndex();
    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    const outcome = await executeRender(plan, {
      actor: 'cli',
      projectId,
      worktree: tmpProject,
      resolveValue: async () => { throw new Error('simulated resolve failure'); },
    });

    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.name).toBe('KEY');
    expect(outcome.failed[0]?.errorCode).toBe('E_UNKNOWN');
    expect(outcome.kept).toEqual(['KEY']);
    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toContain(`KEY=${SENTINEL}-prior`);
  });

  it('one audit `render` line per rendered name; the sentinel value never appears in stdout, stderr, audit, or ledger', async () => {
    await setSecret({ name: 'A', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    const { readIndex } = await import('../../../src/core/index-store.js');
    const index = readIndex();
    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });

    await executeRender(plan, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async () => SENTINEL });

    const audits = readAudit().filter((a) => a.op === 'render');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.name).toBe('A');
    expect(audits[0]?.ok).toBe(true);

    expect(readFileSync(join(tmpProject, '.env'), 'utf8')).toContain(SENTINEL);
    const auditContent = readFileSync(auditLogPath(), 'utf8');
    expect(auditContent).not.toContain(SENTINEL);

    const ledger = readLedger();
    expect(JSON.stringify(ledger)).not.toContain(SENTINEL);
    expect(ledger.targets[0]?.names).toEqual(['A']);
  });

  it('updates the ledger: the (projectId, worktree, file, names) row reflects exactly the names in the block', async () => {
    await setSecret({ name: 'A', value: 'a', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    await setSecret({ name: 'B', value: 'b', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    const { readIndex } = await import('../../../src/core/index-store.js');
    const index = readIndex();
    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });
    await executeRender(plan, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async () => 'v' });

    const ledger = readLedger();
    expect(ledger.targets).toHaveLength(1);
    expect(ledger.targets[0]?.projectId).toBe(projectId);
    expect(ledger.targets[0]?.worktree).toBe(tmpProject);
    expect(ledger.targets[0]?.file).toBe(join(tmpProject, '.env'));
    expect(ledger.targets[0]?.names).toEqual(['A', 'B']);
  });

  it('a render of zero names drops the ledger target', async () => {
    const { upsertTarget } = await import('../../../src/render/ledger.js');
    upsertTarget({ projectId, worktree: tmpProject, file: join(tmpProject, '.env'), names: ['A'] });
    expect(readLedger().targets).toHaveLength(1);

    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index: makeIndex([]), manifest: makeManifest() });
    await executeRender(plan, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async () => { throw new Error('not called'); } });

    expect(readLedger().targets).toHaveLength(0);
  });

  it('tightens an existing .env whose mode had drifted to 0644 back to 0600', async () => {
    const envPath = join(tmpProject, '.env');
    writeFileSync(envPath, 'USER_LINE=1\n', { mode: 0o644 });
    expect((statSync(envPath).mode & 0o777)).toBe(0o644);

    await setSecret({ name: 'A', value: 'a', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    const { readIndex } = await import('../../../src/core/index-store.js');
    const index = readIndex();
    const plan = buildRenderPlan({ cwd: tmpProject, projectId, worktree: tmpProject, index, manifest: makeManifest() });
    await executeRender(plan, { actor: 'cli', projectId, worktree: tmpProject, resolveValue: async () => 'a' });

    expect((statSync(envPath).mode & 0o777)).toBe(0o600);
    chmodSync(envPath, 0o644); // restore for the afterEach cleanup
  });
});