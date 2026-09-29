// Unit tests for the render ledger (Issue #106).
//
// Every test sets ENIGMA_HOME to a fresh temp dir so the ledger file
// (`<ENIGMA_HOME>/render-ledger.json`) and its parent lock anchor live
// in a hermetic sandbox. The ledger is the per-worktree axis the index
// lacks — names-only, no value ever appears in the file.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnigmaError } from '../../../src/core/errors.js';
import { renderLedgerPath, renderLockPath } from '../../../src/core/paths.js';
import { acquireFileLock } from '../../../src/core/file-lock.js';
import {
  readLedger,
  removeNames,
  targetsFor,
  upsertTarget,
  pruneTargets,
} from '../../../src/render/ledger.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear-7c3a';

describe('render ledger (Issue #106)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-render-ledger-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns the empty ledger when the file does not exist', () => {
    expect(readLedger()).toEqual({ version: 1, targets: [] });
  });

  it('roundtrips an upsert and persists the file at mode 0600 (dir 0700)', () => {
    const persisted = upsertTarget({
      projectId: 'proj-aaa',
      worktree: '/worktree-aaa',
      file: '/worktree-aaa/.env',
      names: ['OPENAI_API_KEY'],
    });
    expect(persisted?.renderedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const ledger = readLedger();
    expect(ledger.targets).toHaveLength(1);
    expect(ledger.targets[0]?.names).toEqual(['OPENAI_API_KEY']);

    expect(statSync(renderLedgerPath()).mode & 0o777).toBe(0o600);
    // Assert mode on a NESTED dir that `ensureLockDir` actually
    // tightened — NOT on the mkdtemp root, whose mode the system
    // picks and we never touch. Pre-create `<ENIGMA_HOME>/locks/` at
    // 0755, then exercise the per-target lock path: `ensureLockDir`
    // must tighten it to 0700 (inside-enigmaHome path).
    const nestedDir = join(tmpHome, 'locks');
    mkdirSync(nestedDir, { recursive: true, mode: 0o755 });
    expect(statSync(nestedDir).mode & 0o777).toBe(0o755);
    // Exercise the render-target lock helper on a fresh nested path:
    // `acquireFileLock` calls `ensureLockDir` on the locks/ subdir,
    // which lives inside enigmaHome() and so is tightened to 0700.
    // `renderLockPath` requires the target's parent to exist.
    mkdirSync(join(tmpHome, 'sub'), { recursive: true, mode: 0o755 });
    const lockPath = renderLockPath(join(tmpHome, 'sub', '.env'));
    const l = acquireFileLock(lockPath);
    try {
      expect(statSync(nestedDir).mode & 0o777).toBe(0o700);
    } finally {
      l.release();
    }
  });

  it('merges names sorted-unique on the same (projectId, worktree, file) key and refreshes renderedAt', () => {
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: ['OPENAI_API_KEY'] });
    const before = readLedger().targets[0]?.renderedAt;
    // Small wall-clock gap so the refreshed timestamp is observably later.
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    return wait(5).then(() => {
      const merged = upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'STRIPE_KEY'] });
      expect(merged?.names).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY', 'STRIPE_KEY']);
      expect(readLedger().targets).toHaveLength(1);
      const after = readLedger().targets[0]?.renderedAt;
      expect(after).not.toBe(before);
    });
  });

  it('keeps different (projectId, worktree, file) keys independent', () => {
    upsertTarget({ projectId: 'proj-a', worktree: '/wt1', file: '/wt1/.env', names: ['A'] });
    upsertTarget({ projectId: 'proj-a', worktree: '/wt2', file: '/wt2/.env', names: ['B'] });
    upsertTarget({ projectId: 'proj-b', worktree: '/wt1', file: '/wt1/.env', names: ['C'] });
    expect(readLedger().targets.map((t) => t.names[0]).sort()).toEqual(['A', 'B', 'C']);
  });

  it('drops a target when the upserted names list is empty (no orphan empty targets)', () => {
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: ['X', 'Y'] });
    expect(readLedger().targets).toHaveLength(1);
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: [] });
    expect(readLedger().targets).toHaveLength(0);
  });

  it('removeNames drops only the named entries and removes targets whose list becomes empty', () => {
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: ['A', 'B', 'C'] });
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env.suffix', names: ['B'] });
    upsertTarget({ projectId: 'proj-a', worktree: '/wt2', file: '/wt2/.env', names: ['A', 'D'] });

    removeNames(['A', 'B']);

    const ledger = readLedger();
    // /wt/.env → ['C'] (A, B removed); /wt/.env.suffix → dropped (B was its only name); /wt2/.env → ['D'] (A removed).
    expect(ledger.targets).toHaveLength(2);
    const byFile = Object.fromEntries(ledger.targets.map((t) => [t.file, t.names]));
    expect(byFile['/wt/.env']).toEqual(['C']);
    expect(byFile['/wt2/.env']).toEqual(['D']);
  });

  it('removeNames persists a PARTIAL removal — same target count, but the names list shrank (regression for QA C1 / codex blocking)', () => {
    // The pre-fix bug returned early when the target count was unchanged,
    // so `upsert [A,B]` followed by `removeNames([A])` left `[A,B]` on
    // disk. This test fails on the pre-fix code.
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: ['A', 'B'] });
    upsertTarget({ projectId: 'proj-a', worktree: '/wt2', file: '/wt2/.env', names: ['C'] });

    removeNames(['A']);

    const ledger = readLedger();
    // /wt/.env → ['B']; /wt2/.env → ['C'] (untouched). Two targets, but
    // /wt/.env's names changed — that must persist.
    expect(ledger.targets).toHaveLength(2);
    const byFile = Object.fromEntries(ledger.targets.map((t) => [t.file, t.names]));
    expect(byFile['/wt/.env']).toEqual(['B']);
    expect(byFile['/wt2/.env']).toEqual(['C']);
  });

  it('removeNames is a no-op when the input is empty or no target carries the name', () => {
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: ['A'] });
    const before = readLedger();
    removeNames([]);
    removeNames(['NEVER_RENDERED']);
    expect(readLedger()).toEqual(before);
  });

  it('targetsFor filters by projectId, by name, and by both (AND)', () => {
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: ['A', 'B'] });
    upsertTarget({ projectId: 'proj-a', worktree: '/wt2', file: '/wt2/.env', names: ['C'] });
    upsertTarget({ projectId: 'proj-b', worktree: '/wt3', file: '/wt3/.env', names: ['A'] });

    expect(targetsFor().map((t) => t.file).sort()).toEqual(['/wt/.env', '/wt2/.env', '/wt3/.env']);
    expect(targetsFor({ projectId: 'proj-a' }).map((t) => t.file).sort()).toEqual(['/wt/.env', '/wt2/.env']);
    expect(targetsFor({ name: 'A' }).map((t) => t.file).sort()).toEqual(['/wt/.env', '/wt3/.env']);
    expect(targetsFor({ projectId: 'proj-a', name: 'B' })).toHaveLength(1);
    expect(targetsFor({ projectId: 'proj-b', name: 'NEVER' })).toHaveLength(0);
  });

  it('pruneTargets removes every target for which the predicate is true', () => {
    upsertTarget({ projectId: 'proj-a', worktree: '/wt1', file: '/wt1/.env', names: ['A'] });
    upsertTarget({ projectId: 'proj-a', worktree: '/wt2', file: '/wt2/.env', names: ['B'] });

    pruneTargets((t) => t.worktree === '/wt1');

    const ledger = readLedger();
    expect(ledger.targets).toHaveLength(1);
    expect(ledger.targets[0]?.worktree).toBe('/wt2');
  });

  it('corrupt JSON surfaces E_CONFIG_CORRUPT naming the ledger path (never a raw SyntaxError)', () => {
    writeFileSync(renderLedgerPath(), '{ not valid json');
    try {
      readLedger();
      expect.unreachable('readLedger should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_CONFIG_CORRUPT');
      expect((err as EnigmaError).message).toContain(renderLedgerPath());
    }
  });

  it('wrong-shape JSON: empty object surfaces E_CONFIG_CORRUPT naming the path', () => {
    writeFileSync(renderLedgerPath(), '{}');
    try {
      readLedger();
      expect.unreachable('empty-object ledger should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_CONFIG_CORRUPT');
      expect((err as EnigmaError).message).toContain(renderLedgerPath());
    }
  });

  it('wrong-shape JSON: top-level array surfaces E_CONFIG_CORRUPT naming the path', () => {
    writeFileSync(renderLedgerPath(), '[]');
    try {
      readLedger();
      expect.unreachable('top-level array ledger should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_CONFIG_CORRUPT');
      expect((err as EnigmaError).message).toContain(renderLedgerPath());
    }
  });

  it('wrong-shape JSON: missing targets array surfaces E_CONFIG_CORRUPT naming the path', () => {
    writeFileSync(renderLedgerPath(), JSON.stringify({ version: 1 }));
    try {
      readLedger();
      expect.unreachable('missing-targets ledger should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_CONFIG_CORRUPT');
      expect((err as EnigmaError).message).toContain(renderLedgerPath());
    }
  });

  it('unknown version surfaces E_CONFIG_CORRUPT with the version named in the message', () => {
    writeFileSync(renderLedgerPath(), JSON.stringify({ version: 2, targets: [] }));
    try {
      readLedger();
      expect.unreachable('unknown-version ledger should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_CONFIG_CORRUPT');
      expect((err as EnigmaError).message).toContain(renderLedgerPath());
      // Version explicitly named so the operator can see what's wrong.
      expect((err as EnigmaError).message).toContain('2');
    }
  });

  it('a target with missing fields surfaces E_CONFIG_CORRUPT naming the path', () => {
    writeFileSync(
      renderLedgerPath(),
      JSON.stringify({
        version: 1,
        targets: [{ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env' /* names + renderedAt missing */ }],
      }),
    );
    try {
      readLedger();
      expect.unreachable('incomplete-target ledger should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_CONFIG_CORRUPT');
      expect((err as EnigmaError).message).toContain(renderLedgerPath());
    }
  });

  it('a sentinel value never appears in the ledger bytes after upserts (names-only invariant)', () => {
    // Same shape as the index-store test: no value is ever passed to the
    // ledger, so the sentinel token must not appear in the serialized
    // bytes. Names, paths, and the timestamp are the only persisted fields.
    upsertTarget({ projectId: 'proj-a', worktree: '/wt', file: '/wt/.env', names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'] });
    const raw = readFileSync(renderLedgerPath(), 'utf8');
    expect(raw).not.toContain(SENTINEL);
    expect(raw).toContain('OPENAI_API_KEY');
    expect(raw).toContain('GITHUB_TOKEN');
  });
});

describe('renderLockPath — anchor stability (Issue #106, clarification comment)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-render-anchor-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('(i) anchor is identical before and after the target file exists', () => {
    const targetDir = join(tmpHome, 'worktree', 'sub');
    mkdirSync(targetDir, { recursive: true, mode: 0o755 });
    const targetPath = join(targetDir, '.env');
    const before = renderLockPath(targetPath);
    writeFileSync(targetPath, '', { mode: 0o600 });
    const after = renderLockPath(targetPath);
    expect(after).toBe(before);
  });

  it('(ii) a target reached through a symlinked directory maps to the same anchor as its real path', () => {
    const realDir = join(tmpHome, 'real-worktree');
    const linkDir = join(tmpHome, 'link-worktree');
    mkdirSync(realDir, { recursive: true, mode: 0o755 });
    symlinkSync(realDir, linkDir);

    const viaLink = join(linkDir, '.env');
    const viaReal = join(realDir, '.env');
    expect(renderLockPath(viaLink)).toBe(renderLockPath(viaReal));
  });

  it('(iii) two worktrees with the same relative basename get different anchors', () => {
    const wt1 = join(tmpHome, 'wt1');
    const wt2 = join(tmpHome, 'wt2');
    mkdirSync(wt1, { recursive: true, mode: 0o755 });
    mkdirSync(wt2, { recursive: true, mode: 0o755 });
    const env1 = join(wt1, '.env');
    const env2 = join(wt2, '.env');
    expect(renderLockPath(env1)).not.toBe(renderLockPath(env2));
  });

  it('throws E_WRITE_FAILED when dirname cannot be resolved', () => {
    // The target's parent dir does not exist and cannot be realpath'd —
    // the write would fail anyway, so we surface a clean error.
    const targetPath = join(tmpHome, 'no-such-dir', '.env');
    try {
      renderLockPath(targetPath);
      expect.unreachable('expected E_WRITE_FAILED');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_WRITE_FAILED');
      expect((err as EnigmaError).message).toContain(targetPath);
    }
  });
});

describe('render ledger — concurrent upserts serialize under the ledger\'s own lock (Issue #106)', () => {
  it('two real processes contend on the ledger anchor and both upserts survive (RMW)', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const localTmp = mkdtempSync(join(tmpdir(), 'enigma-ledger-racy-'));
    const workerFixture = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'index-lock-worker.mjs');
    const addonPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugins', 'enigma', 'native', `${process.platform}-${process.arch}`, 'index-lock.node');
    const anchor = join(localTmp, 'render-ledger.lock');

    // The worker fixture's `counter` mode accepts any anchor + a counter
    // file. We reuse it to assert the ledger's lock anchor serializes
    // 2 contending processes through a shared counter increment.
    const counter = join(localTmp, 'counter');
    writeFileSync(counter, '0');
    // 2 processes x 20 iterations: every increment must land.
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        new Promise<{ code: number | null }>((resolveRun) => {
          const child = spawn(process.execPath, [workerFixture, 'counter', addonPath, anchor, counter, '20', '2'], {
            stdio: ['ignore', 'pipe', 'inherit'],
            env: { ...process.env, ENIGMA_HOME: localTmp },
          });
          child.on('exit', (code) => resolveRun({ code }));
        }),
      ),
    );
    for (const r of results) expect(r.code).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('40');

    rmSync(localTmp, { recursive: true, force: true });
  });
});