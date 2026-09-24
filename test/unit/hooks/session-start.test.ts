import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSessionStart } from '../../../src/hooks/session-start.js';
import { RequestStore } from '../../../src/request/store.js';
import { mutateIndex, upsertIndexEntry } from '../../../src/core/index-store.js';
import type { DepositoryId } from '../../../src/storage/interfaces.js';
import { setSecret } from '../../../src/storage/manager.js';
import { configPath } from '../../../src/core/paths.js';

describe('SessionStart', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
    mkdirSync(join(tmpProject, '.git'));
    RequestStore.__resetForTests();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    RequestStore.__resetForTests();
  });

  it('lists no secrets and contains no values when the index is empty', () => {
    const output = runSessionStart({ cwd: tmpProject });
    const ctx = output.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('no secrets registered');
  });

  it('lists project and global secret names, deduplicated', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'sk-a', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    await setSecret({ name: 'STRIPE_KEY', value: 'sk-b', scope: 'global', depository: 'encrypted', actor: 'cli' });

    const output = runSessionStart({ cwd: tmpProject });
    const ctx = output.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('OPENAI_API_KEY');
    expect(ctx).toContain('STRIPE_KEY');
    expect(ctx).not.toContain('sk-a');
    expect(ctx).not.toContain('sk-b');
  });

  it('never includes a secret value even when the value looks like a name', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'DB_PASSWORD-looking-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const output = runSessionStart({ cwd: tmpProject });
    expect(output.hookSpecificOutput.additionalContext).not.toContain('DB_PASSWORD-looking-value');
  });

  it('does not surface another project\'s project-scoped secret', async () => {
    const otherProject = mkdtempSync(join(tmpdir(), 'enigma-other-project-'));
    mkdirSync(join(otherProject, '.git'));
    try {
      await setSecret({ name: 'OTHER_PROJECT_ONLY', value: 'sk-c', scope: 'project', depository: 'encrypted', cwd: otherProject, actor: 'cli' });
      const output = runSessionStart({ cwd: tmpProject });
      expect(output.hookSpecificOutput.additionalContext).not.toContain('OTHER_PROJECT_ONLY');
    } finally {
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it('reports the project manifest\'s sticky default depository', () => {
    writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ defaultDepository: 'keychain', secrets: {} }));
    const output = runSessionStart({ cwd: tmpProject });
    expect(output.hookSpecificOutput.additionalContext).toContain('keychain');
  });

  it('falls back to the global config\'s sticky default when the project has none', () => {
    writeFileSync(configPath(), JSON.stringify({ defaultDepository: 'encrypted' }));
    const output = runSessionStart({ cwd: tmpProject });
    expect(output.hookSpecificOutput.additionalContext).toContain('encrypted');
  });

  it('reports a manifest gap for a declared secret that has no stored value', () => {
    writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ secrets: { MISSING_KEY: 'needed for X' } }));
    const output = runSessionStart({ cwd: tmpProject });
    expect(output.hookSpecificOutput.additionalContext).toContain('MISSING_KEY');
  });

  it('does not report a manifest entry that already has a stored value as a gap', async () => {
    writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ secrets: { OPENAI_API_KEY: 'needed for X' } }));
    await setSecret({ name: 'OPENAI_API_KEY', value: 'sk-a', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const output = runSessionStart({ cwd: tmpProject });
    expect(output.hookSpecificOutput.additionalContext).not.toContain('manifest');
  });

  it('falls back to process.cwd() when cwd is missing from the hook input', () => {
    expect(() => runSessionStart({})).not.toThrow();
  });

  describe('recovery-signal isolation (Issue #68)', () => {
    // The request store lives in memory inside the MCP server process; this
    // hook runs in a separate short-lived subprocess. Even with records that
    // would be "pending unconfirmed" in the MCP process, this hook must not
    // mention them — `enigma_doctor` is the only place the recovery signal
    // surfaces now (regression guard against re-introducing the dead branch).
    it('does not mention a fulfilled-but-unconsumed request from the MCP store', () => {
      const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [
        { name: 'OPENAI_API_KEY', ok: true },
        { name: 'GITHUB_TOKEN', ok: true },
      ]);

      const ctx = runSessionStart({ cwd: tmpProject }).hookSpecificOutput.additionalContext;

      expect(ctx).not.toContain(record.id);
      expect(ctx).not.toContain('OPENAI_API_KEY, GITHUB_TOKEN');
      expect(ctx).not.toContain('enigma_await');
      expect(ctx).not.toContain('pending unconfirmed');
    });

    it('does not mention a fulfilled-but-unconsumed import either', () => {
      const record = RequestStore.create({ kind: 'import', names: ['FOO'] });
      RequestStore.tryMarkUsed(record.id);
      RequestStore.fulfill(record.id, [{ name: 'FOO', ok: true }]);

      const ctx = runSessionStart({ cwd: tmpProject }).hookSpecificOutput.additionalContext;

      expect(ctx).not.toContain(record.id);
      expect(ctx).not.toContain('FOO');
      expect(ctx).not.toContain('enigma_await');
    });

    it('still emits the names/sticky-default/manifest-gap lines (regression: the rest of the hook is unchanged)', () => {
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ defaultDepository: 'keychain', secrets: { MISSING_KEY: 'needed for X' } }));
      const ctx = runSessionStart({ cwd: tmpProject }).hookSpecificOutput.additionalContext;

      expect(ctx).toContain('no secrets registered');
      expect(ctx).toContain('keychain');
      expect(ctx).toContain('MISSING_KEY');
    });
  });

  describe('legacy scope entries (Issue #72)', () => {
    function seedLegacy(name: string, projectPath: string, depository: DepositoryId = 'encrypted'): void {
      mutateIndex((cur) =>
        upsertIndexEntry(cur, {
          name,
          scope: 'project',
          projectId: 'deadbeef00000000',
          projectPath,
          depository,
          ref: `deadbeef00000000/${name}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    }

    it('reports per-class counts and the exact migrate-scope command when this repo has legacy entries', () => {
      seedLegacy('ADOPTABLE_KEY', tmpProject); // path exists → adoptable
      seedLegacy('ORPHAN_KEY', '/definitely/gone/nowhere', 'keychain');
      seedLegacy('ENV_GONE', '/definitely/gone/nowhere', 'env');

      const ctx = runSessionStart({ cwd: tmpProject }).hookSpecificOutput.additionalContext;

      expect(ctx).toContain('1 adoptable');
      expect(ctx).toContain('1 orphaned-adoptable');
      expect(ctx).toContain('1 orphaned-unrecoverable');
      expect(ctx).toContain('enigma migrate-scope');
      expect(ctx).toContain('--apply');
    });

    it('adds no legacy-scope line when there are no legacy entries', async () => {
      await setSecret({ name: 'CURRENT_KEY', value: 'sk-sentinel-value-should-never-appear', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

      const ctx = runSessionStart({ cwd: tmpProject }).hookSpecificOutput.additionalContext;

      expect(ctx).not.toContain('migrate-scope');
      expect(ctx).not.toContain('sk-sentinel-value-should-never-appear');
    });

    it('a corrupt index still cannot reach the transcript — dispatch fail-opens to no output', async () => {
      // readIndex throws E_INDEX_CORRUPT (pre-existing hook behaviour); the
      // dispatch boundary swallows it rather than surfacing a hook error.
      writeFileSync(join(tmpHome, 'index.json'), '{ not valid json');
      const { dispatch } = await import('../../../src/hooks/index.js');

      const output = await dispatch('SessionStart', { cwd: tmpProject });

      expect(output).toBeUndefined();
    });
  });
});
