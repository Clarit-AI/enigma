import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnigmaError } from '../../src/core/errors.js';
import { auditLogPath } from '../../src/core/paths.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

/**
 * `1password` is the only depository that reads `DepositoryContext` at
 * construction time for something other than `env`'s file location, so it's
 * the concrete case used below to pin that `setSecret` actually forwards
 * `projectPath`/`createVault` through to the depository rather than only to
 * `env` (manager.ts previously special-cased `env` alone here — a latent
 * gap `resolveSecret`/`deleteSecret` never had). Mocking `child_process`
 * keeps this deterministic regardless of whether `op` is installed/signed
 * in on the machine running the suite.
 */
interface FakeCall {
  args: string[];
  stdinData: string;
}
const opCalls: FakeCall[] = [];
/**
 * `respondToOp` may return either a sync response or a Promise — the async
 * shape is used by the AC #6 / AC #7 race tests below to defer one
 * `setSecret`'s depository write past another `setSecret`'s index commit,
 * which is the exact interleaving that exposed the lost-update bug.
 */
let respondToOp: (call: FakeCall) => { stdout?: string; stderr?: string; fail?: boolean } | Promise<{ stdout?: string; stderr?: string; fail?: boolean }>;

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
    // Defer respondToOp until after the caller's `child.stdin.write(...)` has
    // populated `call.stdinData` — the AC #6 / AC #7 race tests need to read
    // the title (which lives in the JSON template on stdin) to know which
    // op call is which.
    queueMicrotask(() => {
      let result: { stdout?: string; stderr?: string; fail?: boolean } | Promise<{ stdout?: string; stderr?: string; fail?: boolean }>;
      try {
        result = respondToOp(call);
      } catch (err) {
        callback(err, '', '');
        return;
      }
      Promise.resolve(result).then((r) => {
        if (r.fail) {
          callback(Object.assign(new Error('op failure'), {}), r.stdout ?? '', r.stderr ?? '');
        } else {
          callback(null, r.stdout ?? '', r.stderr ?? '');
        }
      }).catch((err: unknown) => {
        callback(err, '', '');
      });
    });
    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const { deleteSecret, hasSecret, listSecrets, resolveSecret, setSecret } = await import('../../src/storage/manager.js');
const { cmdMove } = await import('../../src/cli/commands/move.js');
const indexStoreModule = await import('../../src/core/index-store.js');

describe('storage manager', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
    mkdirSync(join(tmpProject, '.git'));
    opCalls.length = 0;
    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        return { stdout: JSON.stringify({ id: 'opitemid', title: 'x', category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('sets and resolves a global secret through the encrypted depository', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('sets a project secret through env and records projectPath in clear', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'env', cwd: tmpProject, actor: 'cli' });

    const [entry] = listSecrets({ scope: 'project', cwd: tmpProject });
    expect(entry?.projectPath).toBe(tmpProject);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'project', cwd: tmpProject, actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('env-backed secrets record the bare NAME as ref, and the .env managed block has no scope prefix (B1)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'env', cwd: tmpProject, actor: 'cli' });

    const [entry] = listSecrets({ scope: 'project', cwd: tmpProject });
    expect(entry?.ref).toBe('OPENAI_API_KEY');

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toBe(`# enigma:begin\nOPENAI_API_KEY=${SENTINEL}\n# enigma:end\n`);
  });

  it('setSecret rejects depository "env" with scope "global" with E_SCOPE_INVALID (A1)', async () => {
    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'env', actor: 'cli' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_SCOPE_INVALID' }));
  });

  it('Issue #39: the E_SCOPE_INVALID refusal above is audited, even though it throws before any depository or index access', async () => {
    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'env', actor: 'cli' }),
    ).rejects.toThrow();

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string; name: string; ok: boolean; error: string | null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'OPENAI_API_KEY', ok: false });
    expect(lines[0]?.error).toContain('E_SCOPE_INVALID');
  });

  it('set on an existing name without rotate throws E_EXISTS', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: 'new-value', scope: 'global', depository: 'encrypted', actor: 'cli' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_EXISTS' }));
  });

  it('Issue #39: the E_EXISTS refusal above is audited too — a caller reading the log sees the refusal, not silence', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: 'new-value', scope: 'global', depository: 'encrypted', actor: 'cli' }),
    ).rejects.toThrow();

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string; name: string; ok: boolean; error: string | null });
    // Line 0 is the first, successful set (op: 'set', ok: true); line 1 is the refusal.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ name: 'OPENAI_API_KEY', ok: false });
    expect(lines[1]?.error).toContain('E_EXISTS');
    // PR #52 review: this refusal never rotated anything — rotate is required to be falsy
    // for E_EXISTS to fire at all — so it must never be recorded as 'rotated', the verb for
    // having overwritten something. A naive "show me every rotation" filter on op:'rotated'
    // must never turn up a refusal that changed nothing.
    expect(lines[1]?.op).toBe('set');
    // Never the value, in either the successful or the refused line.
    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    expect(JSON.stringify(lines)).not.toContain('new-value');
  });

  it('set with rotate overwrites and reports rotated: true', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const result = await setSecret({
      name: 'OPENAI_API_KEY',
      value: 'rotated-value',
      scope: 'global',
      depository: 'encrypted',
      rotate: true,
      actor: 'cli',
    });

    expect(result.rotated).toBe(true);
    await expect(resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'cli' })).resolves.toBe('rotated-value');
  });

  it('warns when setting an env secret whose project has no covering .gitignore', async () => {
    const result = await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'env', cwd: tmpProject, actor: 'cli' });
    expect(result.warnings).toHaveLength(1);
  });

  it('project entry shadows global in listSecrets and hasSecret without an explicit scope', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'global-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const views = listSecrets({ scope: 'all', cwd: tmpProject });
    const globalView = views.find((v) => v.scope === 'global');
    expect(globalView?.shadowed).toBe(true);

    await expect(resolveSecret('OPENAI_API_KEY', { cwd: tmpProject, actor: 'cli' })).resolves.toBe(SENTINEL);
  });

  it('deleteSecret with both scopes present and no scope given throws E_AMBIGUOUS_SCOPE', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'global-value', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    await expect(deleteSecret('OPENAI_API_KEY', { cwd: tmpProject, actor: 'cli' })).rejects.toThrow(
      expect.objectContaining({ code: 'E_AMBIGUOUS_SCOPE' }),
    );
  });

  it('deleteSecret removes both the index entry and the underlying value', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    await deleteSecret('OPENAI_API_KEY', { scope: 'global', actor: 'cli' });

    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(false);
  });

  it('resolveSecret throws E_NOT_FOUND for a name that was never set', async () => {
    await expect(resolveSecret('NEVER_SET', { actor: 'cli' })).rejects.toThrow(EnigmaError);
  });

  it('setSecret rejects an invalid name before touching any depository', async () => {
    await expect(
      setSecret({ name: 'not-valid', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_NAME_INVALID' }));
  });

  it('resolveSecret defaults to audit op "read" when auditOp is omitted (Issue #7)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    await resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'user' });

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string });
    expect(lines.at(-1)?.op).toBe('read');
  });

  it('resolveSecret records the overridden audit op when auditOp is given (Issue #7)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    await resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'user', auditOp: 'reveal' });

    const lines = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { op: string });
    expect(lines.at(-1)?.op).toBe('reveal');
  });

  it('setSecret forwards projectPath to a non-env, project-scoped depository (Issue #6 — was previously env-only, a latent gap versus resolveSecret/deleteSecret)', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: '1password', cwd: tmpProject, actor: 'cli' });

    const itemCreateCall = opCalls.find((c) => c.args[0] === 'item' && c.args[1] === 'create');
    expect(itemCreateCall).toBeDefined();
    const template = JSON.parse(itemCreateCall!.stdinData) as { title: string };
    expect(template.title).toBe(`OPENAI_API_KEY · ${basename(tmpProject)}`);
  });

  it('setSecret rejects with E_VAULT_MISSING and creates nothing when the vault is missing and createVault was not passed', async () => {
    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        return { fail: true, stderr: '"Enigma" isn\'t a vault in this account' };
      }
      return { stdout: '' };
    };

    await expect(
      setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: '1password', actor: 'cli' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_VAULT_MISSING' }));
    expect(opCalls.some((c) => c.args[0] === 'vault' && c.args[1] === 'create')).toBe(false);
  });

  it('setSecret end-to-end: createVault reaches the depository via DepositoryContext and creates the vault exactly once', async () => {
    let itemCreateAttempts = 0;
    respondToOp = (call) => {
      if (call.args[0] === 'vault' && call.args[1] === 'create') {
        return { stdout: JSON.stringify({ id: 'vaultid', name: 'Enigma' }) };
      }
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        itemCreateAttempts += 1;
        if (itemCreateAttempts === 1) return { fail: true, stderr: '"Enigma" isn\'t a vault in this account' };
        return { stdout: JSON.stringify({ id: 'opitemid', title: 'x', category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };

    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: '1password', createVault: true, actor: 'cli' });

    expect(opCalls.filter((c) => c.args[0] === 'vault' && c.args[1] === 'create')).toHaveLength(1);
    const [entry] = listSecrets({ scope: 'global' });
    expect(entry?.ref).toBe('opitemid');
  });

  it('Issue #66 AC #5: `enigma move` reaches the index only through mutateIndex (the locked helper), not via a direct writeIndex call', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    const spy = vi.spyOn(indexStoreModule, 'mutateIndex');

    const exitCode = await cmdMove(['OPENAI_API_KEY', '--to', '1password']);

    expect(exitCode).toBe(0);
    expect(spy).toHaveBeenCalled();
    // The delta must see the post-lock authoritative state — it reads the
    // index (not a stale snapshot from before the lock), which is the whole
    // point of routing every write through mutateIndex.
    const delta = spy.mock.calls[0]?.[0];
    expect(typeof delta).toBe('function');
    // Calling the delta with the current index must yield the moved entry
    // pointed at the 1Password ref the depository just returned.
    const before = JSON.parse(JSON.stringify(indexStoreModule.readIndex())) as { entries: Array<{ name: string; depository: string; ref: string }> };
    const next = delta!(before as never);
    expect(next.entries.some((e) => e.name === 'OPENAI_API_KEY' && e.depository === '1password')).toBe(true);

    spy.mockRestore();
  });

  it('Issue #66 AC #6 (setSecret level): two interleaved setSecret calls for DIFFERENT names, where the first call\'s depository write resolves after the second call\'s — both entries survive in the index', async () => {
    // Reproduce the exact interleaving the Issue calls out: A starts, its
    // depository.set is held, B starts and finishes end-to-end (writing its
    // index entry), then A's depository.set resolves. Under the OLD
    // (stale-snapshot) writeIndex, A's writeIndex overwrites B's just-committed
    // entry with A's old snapshot. Under mutateIndex, A re-reads inside the
    // lock and sees B's entry; A's delta adds a different name, so both names
    // survive.
    let releaseA: () => void = () => {};
    const aHeld = new Promise<void>((resolve) => { releaseA = resolve; });
    const aCalls: FakeCall[] = [];

    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        aCalls.push(call);
        const template = JSON.parse(call.stdinData) as { title: string };
        // Global-scope entries use the bare NAME as the title (no " · <project>").
        if (template.title === 'NAME_A') {
          return aHeld.then(() => ({
            stdout: JSON.stringify({ id: 'opid_a', title: template.title, category: 'API_CREDENTIAL' }),
          }));
        }
        return { stdout: JSON.stringify({ id: 'opid_b', title: template.title, category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };

    const aPromise = setSecret({ name: 'NAME_A', value: SENTINEL, scope: 'global', depository: '1password', actor: 'cli' });
    // Let A reach its deferred execFile — one microtask tick is enough for
    // the synchronous pre-checks in setSecret plus the mock's own microtask.
    await new Promise((resolve) => setImmediate(resolve));

    // B completes end-to-end while A is still blocked on its depository write.
    await setSecret({ name: 'NAME_B', value: SENTINEL, scope: 'global', depository: '1password', actor: 'cli' });

    // Sanity: both op calls have been recorded by the mock. A's response
    // is still held (the deferred Promise hasn't resolved), so the depository
    // write for A hasn't happened yet — B's response already fired inside
    // its `await depository.set(...)` and B's index entry is already
    // committed via mutateIndex.
    expect(aCalls).toHaveLength(2);
    const aCallIdx = aCalls.findIndex((c) => JSON.parse(c.stdinData).title === 'NAME_A');
    const bCallIdx = aCalls.findIndex((c) => JSON.parse(c.stdinData).title === 'NAME_B');
    expect(aCallIdx).toBeGreaterThanOrEqual(0);
    expect(bCallIdx).toBeGreaterThanOrEqual(0);

    // Release A — its depository.set resolves, and setSecret proceeds to
    // mutateIndex. Under mutateIndex, A re-reads inside the lock and sees
    // B's entry; A's delta adds NAME_A on top, so both names persist.
    releaseA();
    await aPromise;

    const names = listSecrets({ scope: 'global' }).map((e) => e.name).sort();
    expect(names).toEqual(['NAME_A', 'NAME_B']);
  });

  it('Issue #66 AC #7 (manager level): a `deleteSecret` interleaved with a `setSecret` of a DIFFERENT name, where the set\'s depository write is held — both effects persist', async () => {
    // Seed NAME_X so the delete has something to remove.
    await setSecret({ name: 'NAME_X', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });

    // Hold NAME_Y's depository write until deleteSecret has finished.
    let releaseY: () => void = () => {};
    const yHeld = new Promise<void>((resolve) => { releaseY = resolve; });

    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        const template = JSON.parse(call.stdinData) as { title: string };
        if (template.title === 'NAME_Y') {
          return yHeld.then(() => ({
            stdout: JSON.stringify({ id: 'opid_y', title: template.title, category: 'API_CREDENTIAL' }),
          }));
        }
      }
      // `op item delete` returns empty stdout on success.
      return { stdout: '' };
    };

    // Start the set; it parks on its deferred execFile.
    const yPromise = setSecret({ name: 'NAME_Y', value: SENTINEL, scope: 'global', depository: '1password', actor: 'cli' });
    await new Promise((resolve) => setImmediate(resolve));

    // While NAME_Y is parked, run deleteSecret(NAME_X) end-to-end.
    await deleteSecret('NAME_X', { scope: 'global', actor: 'cli' });

    // Sanity: NAME_X is gone from the index; NAME_Y is NOT yet there.
    const midNames = listSecrets({ scope: 'global' }).map((e) => e.name).sort();
    expect(midNames).toEqual([]);

    // Release NAME_Y's depository.set. Under mutateIndex, the delta re-reads
    // inside the lock — sees the post-delete state (empty) — and adds NAME_Y.
    releaseY();
    await yPromise;

    const finalNames = listSecrets({ scope: 'global' }).map((e) => e.name).sort();
    expect(finalNames).toEqual(['NAME_Y']);
  });

  it('PR #77 review: deleteSecret with an omitted scope removes exactly the GLOBAL entry it resolved before the depository await, even when a same-name PROJECT set commits during that await', async () => {
    // Seed the global entry via 1password so its `op item delete` can be
    // held open — the exact interleaving the review describes.
    await setSecret({ name: 'NAME_SHARED', value: SENTINEL, scope: 'global', depository: '1password', actor: 'cli' });

    let releaseDelete: () => void = () => {};
    const deleteHeld = new Promise<void>((resolve) => { releaseDelete = resolve; });

    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'delete') {
        return deleteHeld.then(() => ({ stdout: '' }));
      }
      return { stdout: '' };
    };

    // Scope OMITTED: at the moment `deleteSecret` resolves which entry to
    // remove, only the global entry exists, so D1.5 shadowing is a
    // non-issue and it unambiguously resolves the global entry — then
    // parks on `depository.delete`.
    const deletePromise = deleteSecret('NAME_SHARED', { cwd: tmpProject, actor: 'cli' });
    await new Promise((resolve) => setImmediate(resolve));

    // While the delete is parked, commit a same-name PROJECT set. Under
    // the pre-fix code (a fresh `resolveIndexEntry(current, name,
    // opts.scope, pid)` re-applying D1.5 *inside* the lock), this new
    // project entry is what the delta would find and wrongly remove,
    // leaving the already-deleted global entry dangling in the index.
    await setSecret({ name: 'NAME_SHARED', value: SENTINEL, scope: 'project', cwd: tmpProject, depository: 'encrypted', actor: 'cli' });

    releaseDelete();
    await deletePromise;

    // The global entry (whose depository value was actually deleted) is
    // gone; the unrelated project entry created during the await survives
    // untouched, and nothing is left dangling.
    const globalNames = listSecrets({ scope: 'global' }).map((e) => e.name);
    const projectNames = listSecrets({ scope: 'project', cwd: tmpProject }).map((e) => e.name);
    expect(globalNames).toEqual([]);
    expect(projectNames).toEqual(['NAME_SHARED']);
    expect(listSecrets({ scope: 'all' })).toHaveLength(1);
  });

  it('deleteSecret refuses (E_NOT_FOUND) rather than removing a different entry when the originally-resolved entry changed ref during the depository await', async () => {
    // Seed a global entry via 1password, held on delete.
    await setSecret({ name: 'NAME_CHANGED', value: SENTINEL, scope: 'global', depository: '1password', actor: 'cli' });

    let releaseDelete: () => void = () => {};
    const deleteHeld = new Promise<void>((resolve) => { releaseDelete = resolve; });
    // Only the FIRST `item delete` — the one deleteSecret issues — is parked.
    // Issue #70's rotate cleanup issues its own best-effort delete of the same
    // (now-displaced) item inside the setSecret below; a shared gate would
    // deadlock the rotate on `deleteHeld`, which is only released afterwards.
    let deleteCalls = 0;
    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'delete') {
        deleteCalls += 1;
        if (deleteCalls === 1) return deleteHeld.then(() => ({ stdout: '' }));
        return { stdout: '' };
      }
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        return { stdout: JSON.stringify({ id: 'opitemid_rotated', title: 'NAME_CHANGED', category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };

    const deletePromise = deleteSecret('NAME_CHANGED', { scope: 'global', actor: 'cli' });
    await new Promise((resolve) => setImmediate(resolve));

    // Same name+scope re-set (rotate: true, since the pre-lock existence
    // check would otherwise refuse before ever reaching the depository)
    // while the delete is parked: the entry's `ref` now points at a
    // different depository item, so it is a DIFFERENT logical entry than
    // the one whose value was just deleted, even though name/scope/
    // projectId still match.
    await setSecret({ name: 'NAME_CHANGED', value: SENTINEL, scope: 'global', depository: '1password', rotate: true, actor: 'cli' });

    releaseDelete();
    await expect(deletePromise).rejects.toMatchObject({ code: 'E_NOT_FOUND' });

    // The refusal must not have touched the new entry.
    expect(listSecrets({ scope: 'global' }).map((e) => e.name)).toEqual(['NAME_CHANGED']);
  });
});
