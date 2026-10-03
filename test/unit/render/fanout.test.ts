/* Fan-out tests (Issue #108). Real `setSecret` / `deleteSecret` / `cmdMove` against a temp
 * ENIGMA_HOME and temp repos with linked worktrees; the only prompting store is the in-memory fake.
 * Every test pins an acceptance criterion that fails without the fan-out.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdMove } from '../../../src/cli/commands/move.js';
import { cmdRemove } from '../../../src/cli/commands/remove.js';
import { auditLogPath, indexPath, renderLedgerPath } from '../../../src/core/paths.js';
import { fanOutRemove, fanOutSet } from '../../../src/render/fanout.js';
import { readLedger } from '../../../src/render/ledger.js';
import { ENV_BEGIN_MARKER, ENV_END_MARKER } from '../../../src/storage/dotenv-file.js';
import { deleteSecret, listSecrets, resolveSecret, setSecret } from '../../../src/storage/manager.js';
import type { FakeStore, Sandbox } from './fanout-helpers.js';
import { SENTINEL, auditLines, block, installFakePromptingStore, makeOtherRepo, makeRepo, makeSandbox, readEnv, seedTarget } from './fanout-helpers.js';

let sb: Sandbox;
let fake: FakeStore | undefined;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
let priorCwd: string;

beforeEach(() => {
  sb = makeSandbox();
  priorCwd = process.cwd();
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.chdir(priorCwd);
  fake?.restore();
  fake = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  sb.cleanup();
});

const out = (): string => [...stdout.mock.calls, ...stderr.mock.calls].map((c: unknown[]) => String(c[0])).join('');
const add = (cwd: string, name: string, value: string, over: Record<string, unknown> = {}) =>
  setSecret({ name, value, scope: 'project', depository: 'encrypted', cwd, actor: 'cli', ...over });
const rotate = (cwd: string, name: string, value: string, over: Record<string, unknown> = {}) => add(cwd, name, value, { rotate: true, ...over });
const ledgerRows = () => readLedger().targets;
const rowFor = (worktree: string) => ledgerRows().find((t) => t.worktree === worktree);

describe('new project secret (AC 1)', () => {
  it('renders into the originating worktree, which becomes a ledger target, keeping other lines byte-identical', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    const original = 'A=1\r\n# keep\r\nB="two words"\r\n';
    writeFileSync(join(w!, '.env'), original);

    const result = await add(w!, 'API_KEY', SENTINEL);

    expect(result.warnings.filter((x) => !x.includes('gitignored'))).toEqual([]);
    const content = readEnv(w!);
    expect(content.startsWith(original)).toBe(true);
    expect(content.slice(original.length)).toBe(`# enigma:render:begin\r\nAPI_KEY=${SENTINEL}\r\n# enigma:render:end\r\n`);
    expect(rowFor(w!)).toMatchObject({ projectId, names: ['API_KEY'], file: join(w!, '.env') });
    expect(auditLines().filter((l) => l.op === 'render')).toEqual([
      expect.objectContaining({ name: 'API_KEY', ok: true, error: null, scope: 'project', projectId, projectPath: w, depository: 'encrypted' }),
    ]);
  });

  it('adds NAME beside the lines already in the block without touching them (merge, not full render)', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    seedTarget(w!, projectId, `PRE=1\n${block('OLD=keep me', 'ZED=z')}POST=2\n`, ['OLD', 'ZED']);

    await add(w!, 'NEW_ONE', 'v');

    expect(readEnv(w!)).toBe(`PRE=1\n${block('OLD=keep me', 'ZED=z', 'NEW_ONE=v')}POST=2\n`);
    expect(rowFor(w!)!.names).toEqual(['NEW_ONE', 'OLD', 'ZED']);
  });

  it('does not add another worktree of the project that is not already a holder', async () => {
    const { worktrees: [a, b] } = makeRepo(sb, 1);
    await add(a!, 'API_KEY', 'v');
    expect(existsSync(join(b!, '.env'))).toBe(false);
    expect(rowFor(b!)).toBeUndefined();
  });

  it('never resolves anything: no depository read happens for a new secret', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    const { encryptedDepositoryModule } = await import('../../../src/storage/depositories/encrypted.js');
    const realCreate = encryptedDepositoryModule.create.bind(encryptedDepositoryModule);
    const resolves: string[] = [];
    vi.spyOn(encryptedDepositoryModule, 'create').mockImplementation((ctx) => {
      const dep = realCreate(ctx);
      return {
        id: dep.id,
        promptProfile: dep.promptProfile,
        set: (ref, value) => dep.set(ref, value),
        delete: (ref) => dep.delete(ref),
        has: (ref) => dep.has(ref),
        resolve: async (ref) => {
          resolves.push(ref);
          return dep.resolve(ref);
        },
      };
    });
    await add(w!, 'API_KEY', 'v');
    expect(readEnv(w!)).toBe(block('API_KEY=v'));
    expect(resolves).toEqual([]);
  });

  it('a prompting-store secret is never auto-rendered', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    fake = installFakePromptingStore();
    await add(w!, 'API_KEY', SENTINEL, { depository: 'keychain' });
    expect(existsSync(join(w!, '.env'))).toBe(false);
    expect(ledgerRows()).toEqual([]);
    expect(fake.resolveCalls).toEqual([]);
  });

  it('an env-depository secret is not duplicated into the render block (#107 AC 3)', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    await add(w!, 'DB_URL', 'postgres://x', { depository: 'env' });
    const content = readEnv(w!);
    expect(content).toContain(ENV_BEGIN_MARKER);
    expect(content).not.toContain('enigma:render');
    expect(content.match(/^DB_URL=/gm)).toHaveLength(1);
    expect(ledgerRows()).toEqual([]);
  });

  it('global-scope secrets are never fanned out', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    seedTarget(w!, projectId, block('G=old'), ['G']);
    const before = readEnv(w!);
    await setSecret({ name: 'G', value: 'new', scope: 'global', depository: 'encrypted', actor: 'cli' });
    await setSecret({ name: 'G', value: 'newer', scope: 'global', depository: 'encrypted', actor: 'cli', rotate: true });
    await deleteSecret('G', { scope: 'global', actor: 'cli' });
    expect(readEnv(w!)).toBe(before);
    expect(auditLines().filter((l) => l.op === 'render' || l.op === 'unrender')).toEqual([]);
  });
});

describe('.enigma.json render settings', () => {
  it('render.enabled:false: the worktree is never written, never warned about, never audited (AC 7)', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    writeFileSync(join(w!, '.enigma.json'), JSON.stringify({ secrets: {}, render: { enabled: false } }));
    const result = await add(w!, 'API_KEY', SENTINEL);
    expect(existsSync(join(w!, '.env'))).toBe(false);
    expect(ledgerRows()).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(auditLines().filter((l) => l.op === 'render')).toEqual([]);
  });

  it('render.enabled:false on a ledger target: rotate and delete leave its file untouched', async () => {
    const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
    await add(a!, 'API_KEY', 'v1');
    seedTarget(b!, projectId, block('API_KEY=v1'), ['API_KEY']);
    writeFileSync(join(b!, '.enigma.json'), JSON.stringify({ secrets: {}, render: { enabled: false } }));
    const before = readEnv(b!);
    const r = await rotate(a!, 'API_KEY', 'v2');
    await deleteSecret('API_KEY', { scope: 'project', cwd: a!, actor: 'cli' });
    expect(readEnv(b!)).toBe(before);
    expect(r.warnings).toEqual([]);
  });

  it('render.names that excludes NAME: a new secret is not rendered', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    writeFileSync(join(w!, '.enigma.json'), JSON.stringify({ secrets: {}, render: { names: ['OTHER'] } }));
    await add(w!, 'API_KEY', 'v');
    expect(existsSync(join(w!, '.env'))).toBe(false);
  });

  it('a custom render.path is the file written', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    writeFileSync(join(w!, '.enigma.json'), JSON.stringify({ secrets: {}, render: { path: 'app.env' } }));
    await add(w!, 'API_KEY', 'v');
    expect(readEnv(w!, 'app.env')).toBe(block('API_KEY=v'));
    expect(existsSync(join(w!, '.env'))).toBe(false);
  });
});

describe('rotate (AC 2, 3)', () => {
  it('updates every ledger target holding NAME from another worktree, leaving all other bytes alone', async () => {
    const { worktrees: [a, b, c], projectId } = makeRepo(sb, 2);
    await add(a!, 'API_KEY', 'v1');
    seedTarget(a!, projectId, `X=1\r\n${block('FIRST=1', 'API_KEY=v1', 'LAST=9').replace(/\n/g, '\r\n')}tail=1\r\n`, ['API_KEY', 'FIRST', 'LAST']);
    seedTarget(b!, projectId, block('API_KEY=v1'), ['API_KEY']);
    seedTarget(c!, projectId, `# hi\n${block('API_KEY=v1', 'Z="a b"')}`, ['API_KEY', 'Z']);
    const auditedBefore = auditLines().length;

    await rotate(b!, 'API_KEY', SENTINEL);

    expect(readEnv(a!)).toBe(`X=1\r\n${block('FIRST=1', `API_KEY=${SENTINEL}`, 'LAST=9').replace(/\n/g, '\r\n')}tail=1\r\n`);
    expect(readEnv(b!)).toBe(block(`API_KEY=${SENTINEL}`));
    expect(readEnv(c!)).toBe(`# hi\n${block(`API_KEY=${SENTINEL}`, 'Z="a b"')}`);
    expect(auditLines().slice(auditedBefore).filter((l) => l.op === 'render').map((l) => l.projectPath).sort()).toEqual([a, b, c].sort());
  });

  it('does not add a worktree that is not a holder', async () => {
    const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
    await add(a!, 'API_KEY', 'v1');
    void projectId;
    await rotate(b!, 'API_KEY', 'v2');
    expect(existsSync(join(b!, '.env'))).toBe(false);
    expect(readEnv(a!)).toBe(block('API_KEY=v2'));
  });

  it('leaves another project that renders the same NAME untouched', async () => {
    const { worktrees: [a] } = makeRepo(sb);
    const other = makeOtherRepo(sb);
    await add(a!, 'API_KEY', 'v1');
    seedTarget(other.worktree, other.projectId, block('API_KEY=other'), ['API_KEY']);
    await rotate(a!, 'API_KEY', 'v2');
    expect(readEnv(other.worktree)).toBe(block('API_KEY=other'));
    expect(rowFor(other.worktree)!.names).toEqual(['API_KEY']);
  });

  it('prompting store: updates a holder with the value in hand, never resolves, never adds a target (C1)', async () => {
    const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
    fake = installFakePromptingStore();
    await add(a!, 'TOKEN', 'v1', { depository: 'keychain' });
    seedTarget(a!, projectId, block('TOKEN=v1', 'OTHER=o'), ['OTHER', 'TOKEN']);
    fake.resolveCalls.length = 0;

    await rotate(b!, 'TOKEN', SENTINEL, { depository: 'keychain' });

    expect(readEnv(a!)).toBe(block(`TOKEN=${SENTINEL}`, 'OTHER=o'));
    expect(existsSync(join(b!, '.env'))).toBe(false);
    // The only keychain read allowed is none: setSecret skips its old-copy capture for a prompting store.
    expect(fake.resolveCalls).toEqual([]);
  });

  describe('per-target failures do not fail the rotate (AC 3)', () => {
    it('gone worktree, unwritable directory, damaged block and symlinked target: warnings, other targets updated, rows kept', async () => {
      const { worktrees: [a, b, c, d, e], projectId } = makeRepo(sb, 4);
      await add(a!, 'API_KEY', 'v1');
      seedTarget(a!, projectId, block('API_KEY=v1'), ['API_KEY']);
      seedTarget(b!, projectId, block('API_KEY=v1'), ['API_KEY']); // goes away
      seedTarget(c!, projectId, block('API_KEY=v1'), ['API_KEY']); // directory made unwritable
      const damaged = '# enigma:render:begin\nAPI_KEY=v1\n# enigma:render:begin\n# enigma:render:end\n';
      seedTarget(d!, projectId, damaged, ['API_KEY']);
      writeFileSync(join(e!, 'real.env'), 'API_KEY=v1\n');
      symlinkSync(join(e!, 'real.env'), join(e!, '.env'));
      const { replaceTarget } = await import('../../../src/render/ledger.js');
      replaceTarget({ projectId, worktree: e!, file: join(e!, '.env'), names: ['API_KEY'] });
      chmodSync(c!, 0o555);
      rmSync(b!, { recursive: true, force: true });

      try {
        const result = await rotate(a!, 'API_KEY', SENTINEL);

        expect(readEnv(a!)).toBe(block(`API_KEY=${SENTINEL}`));
        const text = result.warnings.join('\n');
        expect(text).toContain(`render target ${b} was not updated for API_KEY (worktree-missing)`);
        expect(text).toContain(`render target ${c} was not updated for API_KEY (not-writable)`);
        expect(text).toContain(`render target ${d} was not updated for API_KEY (damaged-render-block)`);
        expect(text).toContain(`render target ${e} was not updated for API_KEY (target-refused)`);
        expect(text).not.toContain(SENTINEL);
        expect(readEnv(d!)).toBe(damaged);
        expect(readFileSync(join(e!, 'real.env'), 'utf8')).toBe('API_KEY=v1\n');
        expect(ledgerRows().map((t) => t.worktree).sort()).toEqual([a, b, c, d, e].sort());
        const failed = auditLines().filter((l) => l.op === 'render' && l.ok === false);
        expect(failed.map((l) => l.error).sort()).toEqual(['damaged-render-block', 'not-writable', 'target-refused', 'worktree-missing']);
      } finally {
        chmodSync(c!, 0o755);
      }
    });

    it('a parent directory that is a symlink out of the worktree is refused and nothing outside is written', async () => {
      const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
      await add(a!, 'API_KEY', 'v1');
      writeFileSync(join(b!, '.enigma.json'), JSON.stringify({ secrets: {}, render: { path: 'sub/.env' } }));
      const outside = join(sb.home, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(b!, 'sub'));
      const { replaceTarget } = await import('../../../src/render/ledger.js');
      replaceTarget({ projectId, worktree: b!, file: join(outside, '.env'), names: ['API_KEY'] });
      const result = await rotate(a!, 'API_KEY', 'v2');
      expect(existsSync(join(outside, '.env'))).toBe(false);
      expect(result.warnings.join('\n')).toContain(`render target ${b} was not updated for API_KEY (target-refused)`);
    });

    it('render.path changed since the ledger row: skipped with a warning, the row kept', async () => {
      const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
      await add(a!, 'API_KEY', 'v1');
      seedTarget(b!, projectId, block('API_KEY=v1'), ['API_KEY']);
      writeFileSync(join(b!, '.enigma.json'), JSON.stringify({ secrets: {}, render: { path: 'other.env' } }));
      const result = await rotate(a!, 'API_KEY', 'v2');
      expect(result.warnings.join('\n')).toContain(`render target ${b} was not updated for API_KEY (render-path-changed)`);
      expect(readEnv(b!)).toBe(block('API_KEY=v1'));
      expect(rowFor(b!)).toBeDefined();
    });
  });
});

describe('delete (AC 4)', () => {
  it('strips NAME from every project target and the ledger; other lines stay; an emptied block goes away', async () => {
    const { worktrees: [a, b, c], projectId } = makeRepo(sb, 2);
    await add(a!, 'API_KEY', 'v1');
    seedTarget(a!, projectId, `X=1\n${block('API_KEY=v1', 'KEEP=k')}Y=2\n`, ['API_KEY', 'KEEP']);
    seedTarget(b!, projectId, `X=1\n${block('API_KEY=v1')}Y=2\n`, ['API_KEY']);
    seedTarget(c!, projectId, block('API_KEY=v1'), ['API_KEY']);

    const result = await deleteSecret('API_KEY', { scope: 'project', cwd: a!, actor: 'cli' });

    expect(result.warnings).toEqual([]);
    expect(readEnv(a!)).toBe(`X=1\n${block('KEEP=k')}Y=2\n`);
    expect(readEnv(b!)).toBe('X=1\nY=2\n');
    expect(readEnv(c!)).toBe('');
    expect(rowFor(a!)!.names).toEqual(['KEEP']);
    expect(rowFor(b!)).toBeUndefined();
    expect(rowFor(c!)).toBeUndefined();
    expect(auditLines().filter((l) => l.op === 'unrender').map((l) => l.projectPath).sort()).toEqual([a, b, c].sort());
  });

  it('two projects sharing a NAME: deleting from P1 leaves P2 row and file intact', async () => {
    const { worktrees: [a], projectId } = makeRepo(sb);
    const p2 = makeOtherRepo(sb);
    await add(a!, 'API_KEY', 'p1');
    seedTarget(a!, projectId, block('API_KEY=p1'), ['API_KEY']);
    await add(p2.worktree, 'API_KEY', 'p2');
    const p2File = readEnv(p2.worktree);

    await deleteSecret('API_KEY', { scope: 'project', cwd: a!, actor: 'cli' });

    expect(readEnv(a!)).toBe('');
    expect(readEnv(p2.worktree)).toBe(p2File);
    expect(rowFor(p2.worktree)!.names).toEqual(['API_KEY']);
  });

  it('a target that cannot be written keeps its row and yields a warning; the delete still succeeds; the CLI prints it to stderr', async () => {
    const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
    await add(a!, 'API_KEY', 'v1');
    seedTarget(b!, projectId, '# enigma:render:begin\nAPI_KEY=v1\n', ['API_KEY']);
    process.chdir(a!);

    expect(await cmdRemove(['API_KEY', '--scope', 'project'])).toBe(0);

    expect(listSecrets({ scope: 'project', cwd: a! })).toEqual([]);
    expect(rowFor(b!)!.names).toEqual(['API_KEY']);
    expect(out()).toContain(`warning: render target ${b} was not updated for API_KEY (damaged-render-block)`);
  });

  it('recreating NAME before the stale strip runs: the strip skips (a render-eligible entry exists again)', async () => {
    const { worktrees: [a], projectId } = makeRepo(sb);
    await add(a!, 'API_KEY', 'v1');
    seedTarget(a!, projectId, block('API_KEY=v1'), ['API_KEY']);
    const warnings = await fanOutRemove({ name: 'API_KEY', projectId, depository: 'encrypted', actor: 'cli' });
    expect(warnings).toEqual([]);
    expect(readEnv(a!)).toBe(block('API_KEY=v1'));
  });
});

describe('move (AC 5, C2)', () => {
  it('to a prompting store: stripped from every render block and the ledger', async () => {
    const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
    await add(a!, 'API_KEY', SENTINEL);
    seedTarget(a!, projectId, block('API_KEY=old', 'KEEP=k'), ['API_KEY', 'KEEP']);
    seedTarget(b!, projectId, block('API_KEY=old'), ['API_KEY']);
    fake = installFakePromptingStore();
    process.chdir(a!);

    expect(await cmdMove(['API_KEY', '--to', 'keychain', '--scope', 'project'])).toBe(0);

    expect(readEnv(a!)).toBe(block('KEEP=k'));
    expect(readEnv(b!)).toBe('');
    expect(rowFor(a!)!.names).toEqual(['KEEP']);
    expect(rowFor(b!)).toBeUndefined();
    expect(fake.values.size).toBe(1);
  });

  it('to encrypted from a prompting store: render blocks keep NAME byte for byte', async () => {
    const { worktrees: [a, b], projectId } = makeRepo(sb, 1);
    fake = installFakePromptingStore();
    await add(a!, 'API_KEY', 'v1', { depository: 'keychain' });
    seedTarget(a!, projectId, block('API_KEY=v1'), ['API_KEY']);
    seedTarget(b!, projectId, block('API_KEY=v1'), ['API_KEY']);
    process.chdir(a!);

    expect(await cmdMove(['API_KEY', '--to', 'encrypted', '--scope', 'project'])).toBe(0);

    expect(readEnv(a!)).toBe(block('API_KEY=v1'));
    expect(readEnv(b!)).toBe(block('API_KEY=v1'));
    expect(rowFor(a!)!.names).toEqual(['API_KEY']);
  });

  it('to env from W: W drops the render line, the env block has it, exactly one NAME line; another worktree keeps its render line (C2)', async () => {
    const { worktrees: [w, other], projectId } = makeRepo(sb, 1);
    await add(w!, 'API_KEY', SENTINEL);
    expect(readEnv(w!)).toContain(`API_KEY=${SENTINEL}`);
    seedTarget(other!, projectId, block(`API_KEY=${SENTINEL}`), ['API_KEY']);
    process.chdir(w!);

    expect(await cmdMove(['API_KEY', '--to', 'env', '--scope', 'project'])).toBe(0);

    const content = readEnv(w!);
    expect(content).toContain(`${ENV_BEGIN_MARKER}\nAPI_KEY=${SENTINEL}\n${ENV_END_MARKER}`);
    expect(content).not.toContain('enigma:render');
    expect(content.match(/^API_KEY=/gm)).toHaveLength(1);
    expect(rowFor(w!)).toBeUndefined();
    expect(readEnv(other!)).toBe(block(`API_KEY=${SENTINEL}`));
    expect(rowFor(other!)!.names).toEqual(['API_KEY']);
    expect(auditLines().filter((l) => l.op === 'unrender').map((l) => l.projectPath)).toEqual([w]);
  });
});

describe('ordering guard (AC 8)', () => {
  it('updatedAt strictly increases per entry even when the clock does not move', async () => {
    const { worktrees: [w] } = makeRepo(sb);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    await add(w!, 'API_KEY', 'v1');
    const first = listSecrets({ scope: 'project', cwd: w! })[0]!.updatedAt;
    await rotate(w!, 'API_KEY', 'v2');
    const second = listSecrets({ scope: 'project', cwd: w! })[0]!.updatedAt;
    await rotate(w!, 'API_KEY', 'v3');
    const third = listSecrets({ scope: 'project', cwd: w! })[0]!.updatedAt;
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    expect(Date.parse(third)).toBeGreaterThan(Date.parse(second));
  });

  it('a stale fan-out (an older commit identity) writes nothing, even within the same millisecond', async () => {
    const { worktrees: [w], projectId } = makeRepo(sb);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'));
    await add(w!, 'API_KEY', 'v1');
    const r1 = listSecrets({ scope: 'project', cwd: w! })[0]!;
    await rotate(w!, 'API_KEY', 'v2');
    expect(readEnv(w!)).toBe(block('API_KEY=v2'));

    const warnings = await fanOutSet({
      name: 'API_KEY',
      value: 'v1-STALE',
      projectId,
      worktree: w!,
      addWorktree: false,
      commit: { updatedAt: r1.updatedAt, ref: r1.ref, depository: r1.depository },
      actor: 'cli',
    });

    expect(warnings).toEqual([]);
    expect(readEnv(w!)).toBe(block('API_KEY=v2'));
    const fresh = listSecrets({ scope: 'project', cwd: w! })[0]!;
    await fanOutSet({ name: 'API_KEY', value: 'v2-AGAIN', projectId, worktree: w!, addWorktree: false, commit: { updatedAt: fresh.updatedAt, ref: fresh.ref, depository: fresh.depository }, actor: 'cli' });
    expect(readEnv(w!)).toBe(block('API_KEY=v2-AGAIN'));
  });
});

describe('sentinel (AC 9)', () => {
  it('no value reaches stdout, stderr, audit, ledger, index, warnings or errors across set/rotate/failure/delete/move', async () => {
    const { worktrees: [a, b, c], projectId } = makeRepo(sb, 2);
    fake = installFakePromptingStore();
    const collected: string[] = [];

    collected.push(...(await add(a!, 'API_KEY', SENTINEL)).warnings);
    seedTarget(b!, projectId, block('API_KEY=old'), ['API_KEY']);
    seedTarget(c!, projectId, '# enigma:render:begin\nAPI_KEY=old\n', ['API_KEY']); // damaged
    collected.push(...(await rotate(a!, 'API_KEY', `${SENTINEL}-2`)).warnings);
    rmSync(b!, { recursive: true, force: true });
    collected.push(...(await rotate(a!, 'API_KEY', `${SENTINEL}-3`)).warnings);
    process.chdir(a!);
    await cmdMove(['API_KEY', '--to', 'keychain', '--scope', 'project']);
    await add(a!, 'SECOND', `${SENTINEL}-s`);
    collected.push(...(await deleteSecret('SECOND', { scope: 'project', cwd: a!, actor: 'cli' })).warnings);
    await expect(add(a!, 'bad name', SENTINEL)).rejects.toBeDefined();
    // Sanity: the sentinel really was in play, and the value path itself still works.
    expect(fake.values.size).toBeGreaterThan(0);
    await expect(resolveSecret('API_KEY', { scope: 'project', cwd: a!, actor: 'cli' })).resolves.toBe(`${SENTINEL}-3`);
    await expect(deleteSecret('API_KEY', { scope: 'project', cwd: c!, actor: 'cli' })).resolves.toBeDefined();

    const surfaces = [out(), collected.join('\n'), readFileSync(auditLogPath(), 'utf8'), readFileSync(renderLedgerPath(), 'utf8'), readFileSync(indexPath(), 'utf8')];
    for (const s of surfaces) expect(s).not.toContain('sentinel-value');
    expect(readFileSync(join(sb.home, 'secrets.enc'), 'utf8')).not.toContain('sentinel-value');
  });
});
