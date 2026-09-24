// Issue #80: every audit line for a `scope: 'project'` operation records
// which project — `projectId` (the repo-identity id, Issue #67) plus
// `projectPath` in clear, exactly as the index records it (D1.1). One
// table-driven suite enumerates every project-scoped (op, file) path the
// issue names, asserting the field is present on the written line.
import { EventEmitter } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventInput, AuditOp } from '../../src/core/audit.js';
import type { IndexEntry, Scope } from '../../src/core/index-store.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

/* ------------------------------------------------------------------ *
 *  Fakes: Map-backed depositories + controllable spawn                 *
 * ------------------------------------------------------------------ */

/** `${depositoryId}:${ref}` → stored value. Shared by every fake module. */
const fakeStore = new Map<string, string>();
/** `${depositoryId}:${ref}` keys whose resolve/delete must throw. */
const failResolves = new Set<string>();
const failDeletes = new Set<string>();

function makeFakeModule(id: string) {
  return {
    id,
    promptProfile: 'none',
    async detect() {
      return { id, promptProfile: 'none', available: true };
    },
    create() {
      return {
        id,
        promptProfile: 'none',
        async set(ref: string, value: string) {
          fakeStore.set(`${id}:${ref}`, value);
          return ref;
        },
        async resolve(ref: string) {
          const key = `${id}:${ref}`;
          if (failResolves.has(key)) throw new Error(`fake ${id} resolve refused`);
          const value = fakeStore.get(key);
          if (value === undefined) throw new Error(`fake ${id}: no value at ${ref}`);
          return value;
        },
        async delete(ref: string) {
          const key = `${id}:${ref}`;
          if (failDeletes.has(key)) throw new Error(`fake ${id} delete refused`);
          fakeStore.delete(key);
        },
        async deleteIfUnchanged(ref: string, expectedValue: string) {
          const key = `${id}:${ref}`;
          if (failDeletes.has(key)) throw new Error(`fake ${id} delete refused`);
          if (fakeStore.get(key) !== expectedValue) return false;
          fakeStore.delete(key);
          return true;
        },
        async has(ref: string) {
          return fakeStore.has(`${id}:${ref}`);
        },
      };
    },
  };
}

vi.mock('../../src/storage/detect.js', () => ({
  DEPOSITORY_MODULES: ['env', 'encrypted', 'keychain', 'secret-service', '1password'].map((id) => makeFakeModule(id)),
}));

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

/** Controls what the next spawned `osascript` answers (the hidden-answer value). */
let osascriptResponse = SENTINEL;
/** When true, the next `pbcopy` fails to spawn — drives clipboard.ts's reveal-failure line. */
let pbcopyFails = false;

const spawnMock = vi.fn((command: string) => {
  const child = new FakeChild();
  queueMicrotask(() => {
    if (command === 'osascript') {
      child.stdout.emit('data', Buffer.from(`${osascriptResponse}\n`));
      child.emit('close', 0);
    } else if (command === 'pbcopy' && pbcopyFails) {
      child.emit('error', new Error('spawn pbcopy ENOENT'));
    } else {
      child.emit('close', 0);
    }
  });
  return child;
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // Same guard as test/setup.ts: no test here may spawn via execFile.
    execFile: (_file: string, _args: unknown[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
      const stdin = new EventEmitter() as EventEmitter & { write: (d: string) => boolean; end: () => void };
      stdin.write = () => true;
      stdin.end = () => {};
      const error = Object.assign(new Error('execFile blocked by test guard'), { code: 'ENOENT' });
      queueMicrotask(() => callback(error, '', ''));
      const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
      child.stdin = stdin;
      child.kill = () => {};
      return child;
    },
    spawn: (command: string) => spawnMock(command),
  };
});

const { appendAuditEvent } = await import('../../src/core/audit.js');
const { setSecret, resolveSecret, deleteSecret } = await import('../../src/storage/manager.js');
const { cmdMove } = await import('../../src/cli/commands/move.js');
const { cmdMigrateScope } = await import('../../src/cli/commands/migrate-scope.js');
const { commitImport } = await import('../../src/storage/import-commit.js');
const { runTripwire } = await import('../../src/hooks/tripwire.js');
const { clipboardReveal } = await import('../../src/native/clipboard.js');
const { nativeRequest } = await import('../../src/native/request.js');
const { parseDotEnv } = await import('../../src/storage/dotenv-file.js');
const { mutateIndex, upsertIndexEntry, __setLockTimingForTesting } = await import('../../src/core/index-store.js');
const { loadIndexLock } = await import('../../src/core/native-lock.js');
const { auditLogPath, indexLockPath } = await import('../../src/core/paths.js');
const { projectId: computeProjectId, findProjectPath } = await import('../../src/core/project.js');

type Line = Record<string, unknown>;

function auditLines(): Line[] {
  if (!existsSync(auditLogPath())) return [];
  return readFileSync(auditLogPath(), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
}

/** The seed writes its own audit line; drop it so each row sees only its own. */
function resetAuditLog(): void {
  rmSync(auditLogPath(), { force: true });
}

function seedIndexEntry(overrides: Partial<IndexEntry> & Pick<IndexEntry, 'name' | 'ref'>): IndexEntry {
  const entry: IndexEntry = {
    scope: 'project',
    depository: 'encrypted',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  mutateIndex((cur) => upsertIndexEntry(cur, entry));
  return entry;
}

interface Row {
  /** Table label — the (op, file) pair the issue names. */
  label: string;
  file: string;
  op: AuditOp;
  ok: boolean;
  /** The secret NAME the asserted audit line must record. */
  name: string;
  /** Seeds state before the audit log is reset; runs before each row's act. */
  arrange?: (ctx: Ctx) => unknown;
  act: (ctx: Ctx) => unknown;
  /** Expected projectId — defaults to the current project's repo id. */
  projectId?: string;
  /** Expected projectPath — defaults to the current project root. */
  projectPath?: string;
}

interface Ctx {
  tmpProject: string;
  pid: string;
}

const LEGACY_PROJECT_ID = 'a'.repeat(16);
const GONE_PATH = join(tmpdir(), 'enigma-80-gone-project-path');

const ROWS: Row[] = [
  {
    label: 'set (ok)',
    file: 'src/storage/manager.ts',
    op: 'set',
    ok: true,
    name: 'SET_OK',
    act: (c) => setSecret({ name: 'SET_OK', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' }),
  },
  {
    label: 'set (refusal — invalid name)',
    file: 'src/storage/manager.ts',
    op: 'set',
    ok: false,
    name: 'NOT A NAME',
    act: (c) => setSecret({ name: 'NOT A NAME', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' }),
  },
  {
    label: 'rotated (ok)',
    file: 'src/storage/manager.ts',
    op: 'rotated',
    ok: true,
    name: 'ROTATED',
    arrange: (c) => setSecret({ name: 'ROTATED', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' }),
    act: (c) => setSecret({ name: 'ROTATED', value: 'sk-rotated-sentinel', scope: 'project', depository: 'encrypted', cwd: c.tmpProject, rotate: true, actor: 'cli' }),
  },
  {
    // Issue #70's post-commit rotate cleanup: displaced entry has a stale
    // ref, the old-location delete fails → 'remove' ok:false line.
    label: 'remove (rotate-cleanup failure)',
    file: 'src/storage/manager.ts',
    op: 'remove',
    ok: false,
    name: 'CLEANUP',
    arrange: async (c) => {
      const oldRef = `${c.pid}/CLEANUP-old`;
      seedIndexEntry({ name: 'CLEANUP', projectId: c.pid, projectPath: c.tmpProject, depository: 'encrypted', ref: oldRef });
      fakeStore.set(`encrypted:${oldRef}`, 'sk-displaced-sentinel');
      failDeletes.add(`encrypted:${oldRef}`);
    },
    act: (c) => setSecret({ name: 'CLEANUP', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, rotate: true, actor: 'cli' }),
  },
  {
    label: 'remove (ok)',
    file: 'src/storage/manager.ts',
    op: 'remove',
    ok: true,
    name: 'REMOVE_ME',
    arrange: (c) => setSecret({ name: 'REMOVE_ME', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' }),
    act: (c) => deleteSecret('REMOVE_ME', { scope: 'project', cwd: c.tmpProject, actor: 'cli' }),
  },
  {
    label: 'read (ok)',
    file: 'src/storage/manager.ts',
    op: 'read',
    ok: true,
    name: 'READ_ME',
    arrange: (c) => setSecret({ name: 'READ_ME', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' }),
    act: (c) => resolveSecret('READ_ME', { scope: 'project', cwd: c.tmpProject, actor: 'cli' }),
  },
  {
    label: 'reveal (ok)',
    file: 'src/storage/manager.ts',
    op: 'reveal',
    ok: true,
    name: 'REVEAL_ME',
    arrange: (c) => setSecret({ name: 'REVEAL_ME', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' }),
    act: (c) => resolveSecret('REVEAL_ME', { scope: 'project', cwd: c.tmpProject, actor: 'user', auditOp: 'reveal', auditMethod: 'clipboard' }),
  },
  {
    // clipboard.ts's own line: resolveSecret already audited reveal ok:true;
    // the pbcopy failure writes a distinct reveal ok:false with entry fields.
    label: 'reveal (clipboard write failure)',
    file: 'src/native/clipboard.ts',
    op: 'reveal',
    ok: false,
    name: 'CLIP_ME',
    arrange: async (c) => {
      await setSecret({ name: 'CLIP_ME', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' });
      pbcopyFails = true;
    },
    act: (c) => clipboardReveal('CLIP_ME', { scope: 'project', cwd: c.tmpProject, actor: 'user' }),
  },
  {
    label: 'move (ok — via setSecret auditOp)',
    file: 'src/cli/commands/move.ts',
    op: 'move',
    ok: true,
    name: 'MOVE_ME',
    arrange: (c) => setSecret({ name: 'MOVE_ME', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' }),
    act: () => cmdMove(['MOVE_ME', '--to', 'env', '--scope', 'project']),
  },
  {
    // move.ts's own line: resolveSecret threw → the 'move' ok:false line.
    label: 'move (resolve failure)',
    file: 'src/cli/commands/move.ts',
    op: 'move',
    ok: false,
    name: 'MOVE_FAIL',
    arrange: async (c) => {
      await setSecret({ name: 'MOVE_FAIL', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' });
      failResolves.add(`encrypted:${c.pid}/MOVE_FAIL`);
    },
    act: () => cmdMove(['MOVE_FAIL', '--to', 'env', '--scope', 'project']),
  },
  {
    label: 'import (ok — via setSecret auditOp)',
    file: 'src/storage/import-commit.ts',
    op: 'import',
    ok: true,
    name: 'IMPORTED',
    act: (c) =>
      commitImport({
        entries: [{ name: 'IMPORTED', value: SENTINEL, ambiguous: false }],
        depository: 'encrypted',
        scope: 'project',
        cwd: c.tmpProject,
        projectPath: c.tmpProject,
        envFilePath: join(c.tmpProject, '.env'),
        actor: 'cli',
      }),
  },
  {
    // import-commit.ts's own line: the ambiguous-value refusal — the one
    // outcome that never reaches setSecret.
    label: 'import (ambiguous refusal)',
    file: 'src/storage/import-commit.ts',
    op: 'import',
    ok: false,
    name: 'AMBIG',
    act: (c) =>
      commitImport({
        entries: [parseDotEnv('AMBIG=one # maybe a comment').entries.find((e) => e.name === 'AMBIG')!],
        depository: 'encrypted',
        scope: 'project',
        cwd: c.tmpProject,
        projectPath: c.tmpProject,
        envFilePath: join(c.tmpProject, '.env'),
        actor: 'cli',
      }),
  },
  {
    label: 'leak',
    file: 'src/hooks/tripwire.ts',
    op: 'leak',
    ok: true,
    name: 'LEAKED',
    arrange: (c) => setSecret({ name: 'LEAKED', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: c.tmpProject, actor: 'cli' }),
    act: (c) =>
      runTripwire({
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        tool_response: { stdout: `the output contains ${SENTINEL} oops`, stderr: '' },
        cwd: c.tmpProject,
      }),
  },
  {
    // request.ts audits transitively through setSecret — the line must still
    // carry the project attribution.
    label: 'set (via nativeRequest)',
    file: 'src/native/request.ts',
    op: 'set',
    ok: true,
    name: 'REQD',
    act: (c) => nativeRequest({ names: ['REQD'], reason: 'table row', scope: 'project', depository: 'encrypted', cwd: c.tmpProject }),
  },
  {
    // A legacy entry whose recorded path still belongs to this repo →
    // adoptable → re-keyed; the 'migrate' line carries the NEW repo id.
    label: 'migrate (re-keyed)',
    file: 'src/cli/commands/migrate-scope.ts',
    op: 'migrate',
    ok: true,
    name: 'LEGACY_OK',
    arrange: () => {
      seedIndexEntry({ name: 'LEGACY_OK', projectId: LEGACY_PROJECT_ID, projectPath: findProjectPath(process.cwd()), depository: 'encrypted', ref: `${LEGACY_PROJECT_ID}/LEGACY_OK` });
    },
    act: () => cmdMigrateScope(['--apply']),
  },
  {
    // migrateScope itself fails (index lock held by this process) → one
    // refused 'migrate' line per rekeyable entry, carrying the entry's own
    // recorded projectId.
    label: 'migrate (refused batch)',
    file: 'src/cli/commands/migrate-scope.ts',
    op: 'migrate',
    ok: false,
    name: 'LEGACY_FAIL',
    projectId: LEGACY_PROJECT_ID,
    arrange: () => {
      seedIndexEntry({ name: 'LEGACY_FAIL', projectId: LEGACY_PROJECT_ID, projectPath: findProjectPath(process.cwd()), depository: 'encrypted', ref: `${LEGACY_PROJECT_ID}/LEGACY_FAIL` });
    },
    act: async () => {
      const addon = loadIndexLock();
      const fd = openSync(indexLockPath(), 'a');
      expect(addon.tryLockSync(fd)).toBe(true);
      __setLockTimingForTesting({ retryIntervalMs: 1, maxAttempts: 2 });
      try {
        await expect(cmdMigrateScope(['--apply'])).rejects.toThrow();
      } finally {
        addon.unlockSync(fd);
        closeSync(fd);
        __setLockTimingForTesting({ retryIntervalMs: 10, maxAttempts: 50 });
      }
    },
  },
  {
    // An orphaned env entry (recorded path gone) is unrecoverable →
    // --prune-unrecoverable removes it; the 'remove' line carries the
    // entry's own recorded project fields.
    label: 'remove (migrate-scope prune)',
    file: 'src/cli/commands/migrate-scope.ts',
    op: 'remove',
    ok: true,
    name: 'ORPHANED',
    projectId: LEGACY_PROJECT_ID,
    projectPath: GONE_PATH,
    arrange: () => {
      seedIndexEntry({ name: 'ORPHANED', projectId: LEGACY_PROJECT_ID, projectPath: GONE_PATH, depository: 'env', ref: 'ORPHANED' });
    },
    act: () => cmdMigrateScope(['--apply', '--prune-unrecoverable']),
  },
];

describe('Issue #80: project-scoped audit lines carry projectId/projectPath', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let pid: string;
  let originalCwd: string;
  let originalPlatform: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    // realpath'd so it matches process.cwd() after chdir on platforms where
    // tmpdir() is a symlink (macOS) — same convention as move.test.ts.
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    pid = computeProjectId(tmpProject);
    originalCwd = process.cwd();
    process.chdir(tmpProject);
    originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fakeStore.clear();
    failResolves.clear();
    failDeletes.clear();
    osascriptResponse = SENTINEL;
    pbcopyFails = false;
    rmSync(GONE_PATH, { recursive: true, force: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  for (const row of ROWS) {
    it(`${row.op} ${row.ok ? 'ok' : 'refusal'} line via ${row.file} — ${row.label}`, async () => {
      const ctx: Ctx = { tmpProject, pid };
      await row.arrange?.(ctx);
      resetAuditLog();
      try {
        await row.act(ctx);
      } catch {
        // refusal rows throw after writing their audit line — expected
      }

      const lines = auditLines().filter((l) => l.op === row.op && l.ok === row.ok && l.name === row.name);
      expect(lines.length, `expected a ${row.op} ${row.ok ? 'ok' : 'failed'} audit line for ${row.name}`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.scope).toBe('project');
        expect(line.projectId).toBe(row.projectId ?? pid);
        expect(line.projectPath).toBe(row.projectPath ?? tmpProject);
        // Names-only is preserved: no value anywhere on the line.
        expect(JSON.stringify(line)).not.toContain(SENTINEL);
      }
    });
  }

  it('a global-scope line carries neither project field', async () => {
    await setSecret({ name: 'GLOBAL_S', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const [line] = auditLines();
    expect(line?.scope).toBe('global');
    expect('projectId' in (line ?? {})).toBe(false);
    expect('projectPath' in (line ?? {})).toBe(false);
  });

  it('a pre-#80 line without project fields still parses alongside new-format lines', () => {
    // A line exactly as written before Issue #80 — no projectId/projectPath.
    const oldLine = JSON.stringify({ ts: '2026-09-23T00:00:00.000Z', op: 'remove', name: 'OLD', scope: 'project', depository: 'encrypted', actor: 'cli', ok: true, error: null });
    writeFileSync(auditLogPath(), `${oldLine}\n`, { mode: 0o600 });
    appendAuditEvent({ op: 'set', name: 'NEW', scope: 'project', projectId: pid, projectPath: tmpProject, depository: 'encrypted', actor: 'cli', ok: true, error: null });

    const lines = auditLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ op: 'remove', name: 'OLD' });
    expect(lines[0]?.projectId).toBeUndefined();
    expect(lines[1]).toMatchObject({ op: 'set', name: 'NEW', projectId: pid, projectPath: tmpProject });
  });

  it('a project-scope literal without projectId is a compile error', () => {
    // @ts-expect-error — scope 'project' requires projectId (Issue #80).
    const event: AuditEventInput = { op: 'set', name: 'A', scope: 'project', depository: 'encrypted', actor: 'cli', ok: true, error: null };
    void event;
  });

  it('a global-scope literal cannot carry projectId', () => {
    // @ts-expect-error — a global line carries no project fields (Issue #80).
    const event: AuditEventInput = { op: 'set', name: 'A', scope: 'global', projectId: pid, depository: 'encrypted', actor: 'cli', ok: true, error: null };
    void event;
  });

  it('an un-narrowed Scope value is refused even with projectId present', () => {
    // A call returning the union keeps `scope` genuinely `Scope` — a const
    // initializer would narrow back to the literal.
    const dynamicScope = (): Scope => 'project';
    // @ts-expect-error — a runtime Scope must go through auditScopeFields, which pairs scope with its project fields (Issue #80).
    const event: AuditEventInput = { op: 'set', name: 'A', scope: dynamicScope(), projectId: pid, depository: 'encrypted', actor: 'cli', ok: true, error: null };
    void event;
  });
});
