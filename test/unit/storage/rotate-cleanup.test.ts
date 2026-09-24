// Issue #70: a same-depository rotate writes the new value, commits the index,
// then removes the displaced copy — best-effort (a cleanup failure warns and
// audits but never fails the rotate), value-free, and never destructive of the
// new data. Different-depository rotates keep today's behaviour (`move` owns
// that cleanup).
//
// Guards pinned here, per the approved mechanism:
//   - stable-address locations are REUSABLE: a captured displaced entry does
//     not stay orphaned, so the delete is gated on (a) the location actually
//     differing, (b) no current index entry referencing that location, and
//     (c) for prompt-free depositories the stored content still being the
//     displaced copy (deleteIfUnchanged) — covering repopulation that lands
//     between the index commit and the delete.
//   - 1password needs none of the value guards: item ids are never reused.
//
// The worktree fixture mirrors env-cross-worktree.test.ts: /repo is the main
// clone's common git dir, /wt-a and /wt-b are linked worktrees sharing its
// projectId. No real keychain/secret-service/1Password binary is exercised —
// `op` is mocked here and every other depository used is local-file only.
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLogPath, secretsPath } from '../../../src/core/paths.js';
import { projectId } from '../../../src/core/project.js';
import { listSecrets, resolveSecret, setSecret } from '../../../src/storage/manager.js';
import { encryptedDepositoryModule } from '../../../src/storage/depositories/encrypted.js';
import { envDepositoryModule } from '../../../src/storage/depositories/env.js';
import * as indexStore from '../../../src/core/index-store.js';
import type { Depository, DepositoryContext } from '../../../src/storage/interfaces.js';

interface FakeCall {
  args: string[];
  stdinData: string;
}
const opCalls: FakeCall[] = [];
let respondToOp: (call: FakeCall) => { stdout?: string; stderr?: string; fail?: boolean };
let opIdCounter = 0;

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as EventEmitter & { write: (d: string) => boolean; end: () => void };
    const call: FakeCall = { args, stdinData: '' };
    stdin.write = (data: string) => {
      call.stdinData += data;
      return true;
    };
    stdin.end = () => {};
    opCalls.push(call);
    const result = respondToOp(call);
    queueMicrotask(() => {
      if (result.fail) {
        callback(Object.assign(new Error('op failure'), {}), result.stdout ?? '', result.stderr ?? '');
      } else {
        callback(null, result.stdout ?? '', result.stderr ?? '');
      }
    });
    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const AUDIT_LINE = /./;
function auditEvents(): Array<Record<string, unknown>> {
  if (!existsSync(auditLogPath())) return [];
  return readFileSync(auditLogPath(), 'utf8')
    .trim()
    .split('\n')
    .filter((l) => AUDIT_LINE.test(l))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function encryptedEntries(): Record<string, unknown> {
  return (JSON.parse(readFileSync(secretsPath(), 'utf8')) as { entries: Record<string, unknown> }).entries;
}

describe('Issue #70 — rotate removes the displaced copy', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let repo: string;
  let wtA: string;
  let wtB: string;
  let other: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;

    repo = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-rot-repo-')));
    mkdirSync(join(repo, '.git', 'worktrees', 'a'), { recursive: true });
    mkdirSync(join(repo, '.git', 'worktrees', 'b'), { recursive: true });
    writeFileSync(join(repo, '.git', 'worktrees', 'a', 'commondir'), '../..\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'a', 'HEAD'), 'ref: refs/heads/a\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'b', 'commondir'), '../..\n');
    writeFileSync(join(repo, '.git', 'worktrees', 'b', 'HEAD'), 'ref: refs/heads/b\n');

    wtA = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-rot-wt-a-')));
    writeFileSync(join(wtA, '.git'), `gitdir: ${repo}/.git/worktrees/a\n`);
    wtB = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-rot-wt-b-')));
    writeFileSync(join(wtB, '.git'), `gitdir: ${repo}/.git/worktrees/b\n`);

    // A second, unrelated repository — its own identity and projectId.
    other = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-rot-other-')));
    mkdirSync(join(other, '.git'));

    opCalls.length = 0;
    opIdCounter = 0;
    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        return { stdout: JSON.stringify({ id: `opid_${++opIdCounter}`, title: 'x', category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    vi.restoreAllMocks();
    for (const dir of [tmpHome, repo, wtA, wtB, other]) rmSync(dir, { recursive: true, force: true });
  });

  it('1password rotate: new item created, index points at it, the OLD item id is deleted', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'global', depository: '1password', actor: 'cli' });
    const result = await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'global', depository: '1password', rotate: true, actor: 'cli' });

    expect(result.rotated).toBe(true);
    expect(opCalls.filter((c) => c.args[0] === 'item' && c.args[1] === 'create')).toHaveLength(2);
    const deletes = opCalls.filter((c) => c.args[0] === 'item' && c.args[1] === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.args[2]).toBe('opid_1');
    expect(deletes[0]!.args).toContain('--vault');

    const [entry] = listSecrets({ scope: 'global' });
    expect(entry?.ref).toBe('opid_2');
  });

  it('1password rotate with a failing old-item delete: still succeeds, warns name+depository, audits remove ok:false — never the value', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'global', depository: '1password', actor: 'cli' });
    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'delete') return { fail: true, stderr: 'insufficient permission' };
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        return { stdout: JSON.stringify({ id: `opid_${++opIdCounter}`, title: 'x', category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };
    const auditBefore = auditEvents().length;

    const result = await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'global', depository: '1password', rotate: true, actor: 'cli' });

    expect(result.rotated).toBe(true);
    const warning = result.warnings.join('\n');
    expect(warning).toContain('API_KEY');
    expect(warning).toContain('1password');
    expect(warning).not.toContain('value-one');
    expect(warning).not.toContain('value-zero');
    expect(warning).not.toContain('insufficient permission');

    const events = auditEvents().slice(auditBefore);
    const remove = events.find((e) => e['op'] === 'remove');
    expect(remove).toMatchObject({ op: 'remove', ok: false, name: 'API_KEY', depository: '1password' });
    expect(JSON.stringify(events)).not.toContain('value-one');
    expect(JSON.stringify(events)).not.toContain('value-zero');

    const [entry] = listSecrets({ scope: 'global' });
    expect(entry?.ref).toBe('opid_2');
  });

  it('encrypted same-ref rotate overwrites in place and does NOT delete the live copy', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'global', depository: 'encrypted', rotate: true, actor: 'cli' });

    expect(Object.keys(encryptedEntries())).toEqual(['global/API_KEY']);
    await expect(resolveSecret('API_KEY', { scope: 'global', actor: 'cli' })).resolves.toBe('value-one');
  });

  it('encrypted rotate where the stored ref is <oldId>/NAME: new value at <newId>/NAME, old key deleted', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'encrypted', cwd: other, actor: 'cli' });
    const oldPid = projectId(other);
    const newPid = projectId(wtA);
    const oldRef = `${oldPid}/API_KEY`;
    expect(encryptedEntries()[oldRef]).toBeDefined();

    // Simulate the post-migrate-scope index shape: entry re-keyed to the
    // current identity while ref still points at the old location.
    indexStore.mutateIndex((current) => ({
      ...current,
      entries: current.entries.map((e) => (e.name === 'API_KEY' ? { ...e, projectId: newPid } : e)),
    }));

    const result = await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'encrypted', cwd: wtA, rotate: true, actor: 'cli' });

    expect(result.rotated).toBe(true);
    const [entry] = listSecrets({ scope: 'project', cwd: wtA });
    expect(entry?.ref).toBe(`${newPid}/API_KEY`);
    const entries = encryptedEntries();
    expect(entries[oldRef]).toBeUndefined();
    expect(entries[`${newPid}/API_KEY`]).toBeDefined();
    await expect(resolveSecret('API_KEY', { scope: 'project', cwd: wtA, actor: 'cli' })).resolves.toBe('value-one');
  });

  it('env rotate from worktree B over an entry recorded at A: value lands in B/.env, A/.env line removed', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'env', cwd: wtA, actor: 'cli' });
    await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'env', cwd: wtB, rotate: true, actor: 'cli' });

    expect(readFileSync(join(wtB, '.env'), 'utf8')).toContain('API_KEY=value-one');
    const aContent = readFileSync(join(wtA, '.env'), 'utf8');
    expect(aContent).not.toMatch(/API_KEY=/);

    const [entry] = listSecrets({ scope: 'project', cwd: wtB });
    expect(entry?.projectPath).toBe(wtB);
  });

  it('env rotate within the same worktree updates in place — no destructive delete of the new line', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'env', cwd: wtA, actor: 'cli' });
    await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'env', cwd: wtA, rotate: true, actor: 'cli' });

    const content = readFileSync(join(wtA, '.env'), 'utf8');
    expect(content).toBe(`# enigma:begin\nAPI_KEY=value-one\n# enigma:end\n`);
  });

  it('env rotate through a symlinked spelling of the same worktree is the SAME location — the new line is preserved', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'env', cwd: wtA, actor: 'cli' });
    const linkPath = join(mkdtempSync(join(tmpdir(), 'enigma-rot-link-')), 'wt-a-link');
    symlinkSync(wtA, linkPath, 'dir');

    // Same physical directory, different lexical spelling: projectId matches
    // (identity realpaths), projectPath differs textually. A lexical compare
    // would call this "different location" and delete the just-written line.
    const result = await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'env', cwd: linkPath, rotate: true, actor: 'cli' });

    expect(result.rotated).toBe(true);
    const content = readFileSync(join(wtA, '.env'), 'utf8');
    expect(content).toContain('API_KEY=value-one');
    rmSync(join(linkPath, '..'), { recursive: true, force: true });
  });

  it('rotate into a DIFFERENT depository leaves the old copy untouched (move owns cross-depository cleanup)', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'encrypted', cwd: wtA, actor: 'cli' });
    const [before] = listSecrets({ scope: 'project', cwd: wtA });
    const oldRef = before!.ref;

    await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'env', cwd: wtA, rotate: true, actor: 'cli' });

    await expect(encryptedDepositoryModule.create({}).has(oldRef)).resolves.toBe(true);
    const [entry] = listSecrets({ scope: 'project', cwd: wtA });
    expect(entry?.depository).toBe('env');
  });

  it('a failing old-copy delete warns name+depository+classified label and audits remove ok:false; the new value stays authoritative', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'env', cwd: wtA, actor: 'cli' });
    const realCreate = envDepositoryModule.create;
    const createSpy = vi.spyOn(envDepositoryModule, 'create').mockImplementation((ctx: DepositoryContext) => {
      const dep = realCreate(ctx);
      if (ctx.projectPath === wtA) {
        return {
          ...dep,
          delete: async () => {
            throw Object.assign(new Error('write blocked'), { code: 'EACCES' });
          },
          deleteIfUnchanged: async () => {
            throw Object.assign(new Error('write blocked'), { code: 'EACCES' });
          },
        } as Depository;
      }
      return dep;
    });
    const auditBefore = auditEvents().length;

    const result = await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'env', cwd: wtB, rotate: true, actor: 'cli' });

    expect(result.rotated).toBe(true);
    const warning = result.warnings.join('\n');
    expect(warning).toContain('API_KEY');
    expect(warning).toContain('env');
    expect(warning).toContain('permission-denied');
    expect(warning).not.toContain('value-one');
    expect(warning).not.toContain('write blocked');

    const events = auditEvents().slice(auditBefore);
    const remove = events.find((e) => e['op'] === 'remove');
    expect(remove).toMatchObject({ op: 'remove', ok: false, name: 'API_KEY', depository: 'env' });
    expect(String(remove?.['error'] ?? '')).toContain('permission-denied');

    expect(readFileSync(join(wtB, '.env'), 'utf8')).toContain('API_KEY=value-one');
    createSpy.mockRestore();
  });

  it('env: repopulation of the displaced location between commit and delete is preserved (changed content)', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'env', cwd: wtA, actor: 'cli' });
    const realCreate = envDepositoryModule.create;
    // A concurrent rotate lands at A after our commit but before our delete:
    // simulated inside the cleanup depository's conditional delete — the
    // stored content no longer equals the captured displaced copy.
    vi.spyOn(envDepositoryModule, 'create').mockImplementation((ctx: DepositoryContext) => {
      const dep = realCreate(ctx);
      if (ctx.projectPath === wtA && dep.deleteIfUnchanged) {
        const conditional = dep.deleteIfUnchanged.bind(dep);
        return {
          ...dep,
          deleteIfUnchanged: async (ref: string, expected: string) => {
            await realCreate(ctx).set('API_KEY', 'repopulated');
            return conditional(ref, expected);
          },
        } as Depository;
      }
      return dep;
    });

    await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'env', cwd: wtB, rotate: true, actor: 'cli' });

    expect(readFileSync(join(wtA, '.env'), 'utf8')).toContain('API_KEY=repopulated');
    expect(readFileSync(join(wtB, '.env'), 'utf8')).toContain('API_KEY=value-one');
  });

  it('env: displaced location whose content still matches the captured copy is deleted', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'env', cwd: wtA, actor: 'cli' });
    const realCreate = envDepositoryModule.create;
    vi.spyOn(envDepositoryModule, 'create').mockImplementation((ctx: DepositoryContext) => {
      const dep = realCreate(ctx);
      if (ctx.projectPath === wtA && dep.deleteIfUnchanged) {
        const conditional = dep.deleteIfUnchanged.bind(dep);
        return {
          ...dep,
          deleteIfUnchanged: async (ref: string, expected: string) => {
            // Same bytes rewritten — indistinguishable from the displaced copy.
            await realCreate(ctx).set('API_KEY', 'value-zero');
            return conditional(ref, expected);
          },
        } as Depository;
      }
      return dep;
    });

    await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'env', cwd: wtB, rotate: true, actor: 'cli' });

    expect(readFileSync(join(wtA, '.env'), 'utf8')).not.toMatch(/API_KEY=/);
  });

  it('env: an index entry re-pointing at the displaced location (committed repopulation) suppresses the delete', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'env', cwd: wtA, actor: 'cli' });

    const realReadIndex = indexStore.readIndex;
    let flipped = false;
    vi.spyOn(indexStore, 'readIndex').mockImplementation(() => {
      // Flip the moment a read observes our committed entry at B — i.e. on
      // the first post-commit read (the cleanup recheck). A concurrent
      // rotate landing between commit and delete is simulated by committing
      // an entry that points back at A right here, under mutateIndex.
      const idx = realReadIndex();
      const entry = idx.entries.find((e) => e.name === 'API_KEY');
      if (!flipped && entry?.projectPath === wtB) {
        flipped = true;
        indexStore.mutateIndex((current) => ({
          ...current,
          entries: current.entries.map((e) => (e.name === 'API_KEY' ? { ...e, projectPath: wtA } : e)),
        }));
        return realReadIndex();
      }
      return idx;
    });

    await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'env', cwd: wtB, rotate: true, actor: 'cli' });

    const [entry] = listSecrets({ scope: 'project', cwd: wtB });
    expect(entry?.projectPath).toBe(wtA);
    // The delete was suppressed even though A/.env's content matched the
    // displaced copy — the location is current again.
    expect(readFileSync(join(wtA, '.env'), 'utf8')).toContain('API_KEY=value-zero');
  });

  it('encrypted: repopulation of the displaced key between commit and delete is preserved (changed content)', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'encrypted', cwd: other, actor: 'cli' });
    const oldPid = projectId(other);
    const newPid = projectId(wtA);
    const oldRef = `${oldPid}/API_KEY`;
    indexStore.mutateIndex((current) => ({
      ...current,
      entries: current.entries.map((e) => (e.name === 'API_KEY' ? { ...e, projectId: newPid } : e)),
    }));

    const realCreate = encryptedDepositoryModule.create;
    vi.spyOn(encryptedDepositoryModule, 'create').mockImplementation((ctx: DepositoryContext) => {
      const dep = realCreate(ctx);
      if (dep.deleteIfUnchanged) {
        const conditional = dep.deleteIfUnchanged.bind(dep);
        return {
          ...dep,
          deleteIfUnchanged: async (ref: string, expected: string) => {
            await realCreate(ctx).set(oldRef, 'repopulated');
            return conditional(ref, expected);
          },
        } as Depository;
      }
      return dep;
    });

    await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'encrypted', cwd: wtA, rotate: true, actor: 'cli' });

    await expect(encryptedDepositoryModule.create({}).resolve(oldRef)).resolves.toBe('repopulated');
    await expect(resolveSecret('API_KEY', { scope: 'project', cwd: wtA, actor: 'cli' })).resolves.toBe('value-one');
  });

  it('encrypted: displaced key whose content still matches the captured copy is deleted', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'project', depository: 'encrypted', cwd: other, actor: 'cli' });
    const oldPid = projectId(other);
    const newPid = projectId(wtA);
    const oldRef = `${oldPid}/API_KEY`;
    indexStore.mutateIndex((current) => ({
      ...current,
      entries: current.entries.map((e) => (e.name === 'API_KEY' ? { ...e, projectId: newPid } : e)),
    }));

    await setSecret({ name: 'API_KEY', value: 'value-one', scope: 'project', depository: 'encrypted', cwd: wtA, rotate: true, actor: 'cli' });

    expect(encryptedEntries()[oldRef]).toBeUndefined();
  });

  it('rotate on a name with no existing entry performs no delete at all', async () => {
    const deleteSpy = vi.fn();
    const realCreate = encryptedDepositoryModule.create;
    vi.spyOn(encryptedDepositoryModule, 'create').mockImplementation((ctx: DepositoryContext) => ({
      ...realCreate(ctx),
      delete: deleteSpy,
    }) as Depository);

    await setSecret({ name: 'FRESH_NAME', value: 'value-zero', scope: 'global', depository: 'encrypted', actor: 'cli' });

    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('a failed depository write is a refusal — no cleanup delete is attempted', async () => {
    await setSecret({ name: 'API_KEY', value: 'value-zero', scope: 'global', depository: '1password', actor: 'cli' });
    respondToOp = () => ({ fail: true, stderr: 'op exploded' });
    opCalls.length = 0;

    await expect(
      setSecret({ name: 'API_KEY', value: 'value-one', scope: 'global', depository: '1password', rotate: true, actor: 'cli' }),
    ).rejects.toThrow();

    expect(opCalls.some((c) => c.args[0] === 'item' && c.args[1] === 'delete')).toBe(false);
  });
});
