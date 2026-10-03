/* Unit tests for the renderer (Issue #107, incl. the r1 fix batch).
 *
 * Tests tagged `[rN.k]` pin item k of the r1 fix batch: each one fails on
 * the r0 head (89be7fa) and passes on the fix. Hermetic: ENIGMA_HOME and
 * the worktree are temp dirs, values come from an injected resolver, and
 * no depository store (Keychain, 1Password, ...) is ever touched.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireFileLock } from '../../../src/core/file-lock.js';
import { EnigmaError } from '../../../src/core/errors.js';
import { auditLogPath, renderLockPath } from '../../../src/core/paths.js';
import { mutateIndex } from '../../../src/core/index-store.js';
import type { IndexFile } from '../../../src/core/index-store.js';
import type { ProjectManifest } from '../../../src/core/config.js';
import { buildRenderPlan, executeRender } from '../../../src/render/render.js';
import type { RenderOutcome } from '../../../src/render/render.js';
import { readLedger, upsertTarget } from '../../../src/render/ledger.js';
import { checkEnvGitignore } from '../../../src/storage/depositories/env.js';
import { ENV_BEGIN_MARKER, ENV_END_MARKER, RENDER_BEGIN_MARKER, RENDER_END_MARKER, parseDotEnv } from '../../../src/storage/dotenv-file.js';
import type { DepositoryId } from '../../../src/storage/interfaces.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear-7c3a';
const PID = 'pid-render-test';

let home: string;
let project: string;
let priorHome: string | undefined;
let priorCwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'enigma-home-'));
  project = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
  mkdirSync(join(project, '.git'));
  priorHome = process.env.ENIGMA_HOME;
  process.env.ENIGMA_HOME = home;
  priorCwd = process.cwd();
  process.chdir(project);
});

afterEach(() => {
  process.chdir(priorCwd);
  if (priorHome === undefined) delete process.env.ENIGMA_HOME;
  else process.env.ENIGMA_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const envPath = (): string => join(project, '.env');
const read = (path = envPath()): string => readFileSync(path, 'utf8');
const block = (...lines: string[]): string => `${RENDER_BEGIN_MARKER}\n${lines.map((l) => `${l}\n`).join('')}${RENDER_END_MARKER}\n`;
const envBlock = (...lines: string[]): string => `${ENV_BEGIN_MARKER}\n${lines.map((l) => `${l}\n`).join('')}${ENV_END_MARKER}\n`;

function entry(name: string, depository: DepositoryId = 'encrypted', over: Record<string, unknown> = {}): IndexFile['entries'][number] {
  return {
    name,
    scope: 'project',
    projectId: PID,
    projectPath: project,
    depository,
    ref: `${PID}/${name}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as IndexFile['entries'][number];
}

// Issue #108 (Rule C): a plan carries the identity of the index entry it selected, and the renderer compares it with
// the LIVE index before resolving. These tests plan from a hand-built index, so it is also written to the (temp)
// ENIGMA_HOME index: plan and live index agree, as they do when `enigma render` reads the index it plans from.
const indexOf = (...entries: IndexFile['entries']): IndexFile => {
  const built: IndexFile = { version: 1, entries };
  mutateIndex(() => built);
  return built;
};
const manifestOf = (over: Partial<ProjectManifest> = {}): ProjectManifest => ({ secrets: {}, ...over });

type Resolver = (name: string, depository: DepositoryId) => Promise<string>;
const fixedValues =
  (values: Record<string, string>): Resolver =>
  async (name) => {
    const value = values[name];
    if (value === undefined) throw new EnigmaError({ code: 'E_NOT_FOUND', message: `no value for ${name}` });
    return value;
  };

async function run(opts: {
  index: IndexFile;
  resolve?: Resolver;
  manifest?: ProjectManifest;
  explicitName?: string;
}): Promise<RenderOutcome> {
  const plan = buildRenderPlan({
    cwd: project,
    projectId: PID,
    worktree: project,
    index: opts.index,
    manifest: opts.manifest ?? manifestOf(),
    explicitName: opts.explicitName,
  });
  return executeRender(plan, {
    actor: 'cli',
    projectId: PID,
    worktree: project,
    resolveValue: opts.resolve ?? (async () => 'v'),
  });
}

function audits(): Array<Record<string, unknown>> {
  return existsSync(auditLogPath())
    ? read(auditLogPath()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((a) => a.op === 'render')
    : [];
}

describe('buildRenderPlan', () => {
  it('[r1.2] the plan is names-only: no kept line or value can be in it, even when the file holds them', () => {
    writeFileSync(envPath(), block(`KC_KEY=${SENTINEL}`, `OTHER=${SENTINEL}`), { mode: 0o600 });
    const index = indexOf(entry('KC_KEY', 'keychain'), entry('OTHER'), entry('NEW'));
    for (const explicitName of [undefined, 'NEW']) {
      const plan = buildRenderPlan({ cwd: project, projectId: PID, worktree: project, index, manifest: manifestOf(), explicitName });
      expect(JSON.stringify(plan)).not.toContain(SENTINEL);
    }
  });

  it('classifies project entries: profile none → toResolve, prompting store → promptingStore, narrowed → narrowedOut; global entries are ignored', () => {
    const index = indexOf(
      entry('ENC'),
      entry('ENVDEPO', 'env'),
      entry('KC', 'keychain'),
      entry('NARROW'),
      entry('GLOBAL_ONE', 'encrypted', { scope: 'global', projectId: undefined, projectPath: undefined, ref: 'global/GLOBAL_ONE' }),
      entry('OTHER_PROJECT', 'encrypted', { projectId: 'someone-else' }),
    );
    const plan = buildRenderPlan({
      cwd: project, projectId: PID, worktree: project, index,
      manifest: manifestOf({ render: { names: ['ENC', 'ENVDEPO', 'KC'] } }),
    });
    expect(plan.toResolve.map((t) => t.name)).toEqual(['ENC', 'ENVDEPO']);
    expect(plan.promptingStore.map((t) => t.name)).toEqual(['KC']);
    expect(plan.narrowedOut).toEqual(['NARROW']);
    expect(plan.file).toBe(envPath());
  });

  it('render.enabled=false yields a disabled plan with nothing to do', () => {
    const plan = buildRenderPlan({ cwd: project, projectId: PID, worktree: project, index: indexOf(entry('A')), manifest: manifestOf({ render: { enabled: false } }) });
    expect(plan.enabled).toBe(false);
    expect(plan.toResolve).toEqual([]);
  });

  it('explicit NAME: E_NOT_FOUND for a name that is not a project secret of this repo; otherwise toResolve is only NAME', () => {
    const index = indexOf(entry('OTHER', 'encrypted', { projectId: 'someone-else' }), entry('A'), entry('B'));
    expect(() => buildRenderPlan({ cwd: project, projectId: PID, worktree: project, index, manifest: manifestOf(), explicitName: 'OTHER' })).toThrow(
      expect.objectContaining({ code: 'E_NOT_FOUND' }),
    );
    const plan = buildRenderPlan({ cwd: project, projectId: PID, worktree: project, index, manifest: manifestOf(), explicitName: 'B' });
    expect(plan.explicit).toBe(true);
    // Issue #108: the plan also carries the identity of the entry it selected (updatedAt|ref|depository).
    expect(plan.toResolve).toEqual([{ name: 'B', depository: 'encrypted', identity: '2026-01-01T00:00:00Z|pid-render-test/B|encrypted' }]);
  });

  describe('render.path validation (before any read)', () => {
    const planFor = (path: string) => () =>
      buildRenderPlan({ cwd: project, projectId: PID, worktree: project, index: indexOf(), manifest: manifestOf({ render: { path } }) });

    it('refuses an absolute path', () => {
      expect(planFor('/etc/passwd')).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED' }));
    });

    it('refuses a `..` segment', () => {
      expect(planFor('../escape.env')).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED' }));
    });

    it('refuses a missing parent directory and does not create it', () => {
      expect(planFor('no-such-dir/.env')).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED' }));
      expect(existsSync(join(project, 'no-such-dir'))).toBe(false);
    });

    it('refuses a parent directory that is a symlink out of the worktree', () => {
      const outside = join(home, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(project, 'escape'));
      expect(planFor('escape/file.env')).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED' }));
    });

    it('[r2.5] refuses a target that is a directory', () => {
      mkdirSync(envPath());
      expect(planFor('.env')).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED', message: expect.stringContaining('not a regular file') }));
    });

    it.each(['', '.', 'config/', 'config\\'])('[r2.5] refuses the path %j with a message saying it must name a file', (path) => {
      mkdirSync(join(project, 'config'));
      expect(planFor(path)).toThrow(expect.objectContaining({ code: 'E_WRITE_FAILED', message: expect.stringContaining('must name a file') }));
    });

    it('[r2.5] nothing is resolved when the target is refused up front', async () => {
      mkdirSync(envPath());
      let resolves = 0;
      await expect(run({ index: indexOf(entry('A')), resolve: async () => { resolves++; return 'v'; } })).rejects.toMatchObject({ code: 'E_WRITE_FAILED' });
      expect(resolves).toBe(0);
    });

    it('[r1.4] refuses a target file that is a symlink, without reading through it or replacing it', async () => {
      const real = join(project, 'real.env');
      writeFileSync(real, 'REAL=1\n', { mode: 0o600 });
      symlinkSync(real, envPath());
      await expect(run({ index: indexOf(entry('A')) })).rejects.toMatchObject({ code: 'E_WRITE_FAILED' });
      expect(lstatSync(envPath()).isSymbolicLink()).toBe(true);
      expect(read(real)).toBe('REAL=1\n');
    });

    it('[r1.4] a dangling symlink target is refused too', async () => {
      symlinkSync(join(project, 'nowhere.env'), envPath());
      await expect(run({ index: indexOf(entry('A')) })).rejects.toMatchObject({ code: 'E_WRITE_FAILED' });
      expect(lstatSync(envPath()).isSymbolicLink()).toBe(true);
      expect(existsSync(join(project, 'nowhere.env'))).toBe(false);
    });

    it('[r1.4] a target swapped for a symlink between planning and executing is refused under the lock', async () => {
      const plan = buildRenderPlan({ cwd: project, projectId: PID, worktree: project, index: indexOf(entry('A')), manifest: manifestOf() });
      const real = join(project, 'real.env');
      writeFileSync(real, 'REAL=1\n', { mode: 0o600 });
      symlinkSync(real, envPath());
      await expect(executeRender(plan, { actor: 'cli', projectId: PID, worktree: project, resolveValue: async () => 'v' })).rejects.toMatchObject({
        code: 'E_WRITE_FAILED',
      });
      expect(read(real)).toBe('REAL=1\n');
    });
  });
});

describe('executeRender', () => {
  it('writes the block for the auto set at mode 0600 and records the names in the ledger', async () => {
    const outcome = await run({ index: indexOf(entry('A'), entry('B')), resolve: fixedValues({ A: 'a-val', B: 'b val' }) });
    expect(outcome.rendered).toEqual(['A', 'B']);
    expect(read()).toBe(block('A=a-val', 'B="b val"'));
    expect(statSync(envPath()).mode & 0o777).toBe(0o600);
    expect(readLedger().targets).toEqual([expect.objectContaining({ projectId: PID, worktree: project, file: envPath(), names: ['A', 'B'] })]);
  });

  it('a second identical render leaves identical bytes', async () => {
    const index = indexOf(entry('A'), entry('B'));
    const resolve = fixedValues({ A: 'a', B: 'b' });
    await run({ index, resolve });
    const first = read();
    await run({ index, resolve });
    expect(read()).toBe(first);
  });

  it('tightens a target whose mode had drifted to 0644', async () => {
    writeFileSync(envPath(), 'USER_LINE=1\n', { mode: 0o644 });
    chmodSync(envPath(), 0o644);
    await run({ index: indexOf(entry('A')) });
    expect(statSync(envPath()).mode & 0o777).toBe(0o600);
  });

  it('keeps CRLF line endings and every byte outside the block', async () => {
    writeFileSync(envPath(), 'USER_LINE=1\r\nOTHER=2', { mode: 0o600 });
    await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a' }) });
    // The block always ends with an EOL in the file's style.
    expect(read()).toBe(`USER_LINE=1\r\nOTHER=2\r\n${RENDER_BEGIN_MARKER}\r\nA=a\r\n${RENDER_END_MARKER}\r\n`);
  });

  it('render.enabled=false does nothing', async () => {
    const outcome = await run({ index: indexOf(entry('A')), manifest: manifestOf({ render: { enabled: false } }) });
    expect(outcome.disabled).toBe(true);
    expect(existsSync(envPath())).toBe(false);
    expect(audits()).toEqual([]);
  });

  describe('[r1.1] AC #3: env-block names are not duplicated into the render block', () => {
    it('a name in this file\'s env block is left out of the render block and reported by name; the env block is byte-identical', async () => {
      const original = `USER_LINE=1\n${envBlock('A=envblock-a')}`;
      writeFileSync(envPath(), original, { mode: 0o600 });
      const outcome = await run({ index: indexOf(entry('A', 'env'), entry('B')), resolve: fixedValues({ A: 'fresh-a', B: 'fresh-b' }) });
      expect(read()).toBe(`${original}${block('B=fresh-b')}`);
      expect(outcome.alreadyInEnvBlock).toEqual(['A']);
      expect(outcome.rendered).toEqual(['B']);
      expect(readLedger().targets[0]?.names).toEqual(['B']);
      expect(audits().map((a) => a.name)).toEqual(['B']);
    });

    it('AC #1 still holds: an env-depository secret IS rendered into a target that does not carry it in its env block', async () => {
      const outcome = await run({ index: indexOf(entry('A', 'env')), resolve: fixedValues({ A: 'from-store' }) });
      expect(read()).toBe(block('A=from-store'));
      expect(outcome.alreadyInEnvBlock).toEqual([]);
      expect(outcome.rendered).toEqual(['A']);
    });

    it('a stale render line for a name that is now in the env block is dropped', async () => {
      writeFileSync(envPath(), `${envBlock('A=envblock-a')}${block('A=stale', 'B=old-b')}`, { mode: 0o600 });
      const outcome = await run({ index: indexOf(entry('A'), entry('B')), resolve: fixedValues({ A: 'x', B: 'new-b' }) });
      expect(read()).toBe(`${envBlock('A=envblock-a')}${block('B=new-b')}`);
      expect(outcome.removed).toEqual(['A']);
      expect(outcome.alreadyInEnvBlock).toEqual(['A']);
    });

    it('an explicit render of an env-block name writes nothing for it and says why', async () => {
      const original = envBlock('A=envblock-a');
      writeFileSync(envPath(), original, { mode: 0o600 });
      const outcome = await run({ index: indexOf(entry('A')), explicitName: 'A', resolve: fixedValues({ A: 'x' }) });
      expect(read()).toBe(original);
      expect(outcome.alreadyInEnvBlock).toEqual(['A']);
      expect(outcome.rendered).toEqual([]);
      expect(outcome.failed).toEqual([]);
    });
  });

  describe('[r1.2] lines already in the block are copied as bytes from the locked read', () => {
    it('a previously rendered prompting-store line is kept verbatim with no resolve', async () => {
      const original = block(`KC_KEY=${SENTINEL}-old`);
      writeFileSync(envPath(), original, { mode: 0o600 });
      let resolves = 0;
      const outcome = await run({
        index: indexOf(entry('KC_KEY', 'keychain')),
        resolve: async () => { resolves++; return 'nope'; },
      });
      expect(resolves).toBe(0);
      expect(outcome.kept).toEqual(['KC_KEY']);
      expect(read()).toBe(original);
      expect(readLedger().targets[0]?.names).toEqual(['KC_KEY']);
    });

    it('a prompting-store secret never rendered is skipped, and with nothing else to write the file is not created', async () => {
      const outcome = await run({ index: indexOf(entry('KC_KEY', 'keychain')) });
      expect(outcome.skipped).toEqual([{ name: 'KC_KEY', reason: 'prompting-store' }]);
      expect(existsSync(envPath())).toBe(false);
    });

    it('an explicit render merges: only NAME changes, every other line is byte-identical', async () => {
      writeFileSync(envPath(), `USER=1\n${block('A=stale-a', 'B=stale-b')}`, { mode: 0o600 });
      const outcome = await run({ index: indexOf(entry('A'), entry('C')), explicitName: 'C', resolve: fixedValues({ C: 'c-val' }) });
      expect(read()).toBe(`USER=1\n${block('A=stale-a', 'B=stale-b', 'C=c-val')}`);
      expect(outcome.rendered).toEqual(['C']);
      expect(outcome.kept).toEqual(['A', 'B']);
      expect(readLedger().targets[0]?.names).toEqual(['A', 'B', 'C']);
    });

    it('an explicit render can render a prompting-store secret', async () => {
      const outcome = await run({ index: indexOf(entry('KC_KEY', 'keychain')), explicitName: 'KC_KEY', resolve: fixedValues({ KC_KEY: 'kc-val' }) });
      expect(outcome.rendered).toEqual(['KC_KEY']);
      expect(read()).toBe(block('KC_KEY=kc-val'));
    });
  });

  describe('[r1.3] validate, resolve, then lock; everything file-derived comes from the locked read', () => {
    it('the lock is not held while values are being resolved', async () => {
      let lockFreeDuringResolve = false;
      await run({
        index: indexOf(entry('A')),
        resolve: async () => {
          const probe = acquireFileLock(renderLockPath(envPath()));
          probe.release();
          lockFreeDuringResolve = true;
          return 'v';
        },
      });
      expect(lockFreeDuringResolve).toBe(true);
      expect(read()).toBe(block('A=v'));
    });

    it('the lock is released afterwards, also after a failed write', async () => {
      const blocked = join(project, 'blocked');
      mkdirSync(blocked, { mode: 0o700 });
      chmodSync(blocked, 0o500);
      try {
        await run({ index: indexOf(entry('A')), manifest: manifestOf({ render: { path: 'blocked/.env' } }) });
        acquireFileLock(renderLockPath(join(blocked, '.env'))).release();
      } finally {
        chmodSync(blocked, 0o700);
      }
    });

    it('env-block, previous-line and removal decisions use the file as it is when the lock is taken, not as it was at planning time', async () => {
      const plan = buildRenderPlan({ cwd: project, projectId: PID, worktree: project, index: indexOf(entry('A'), entry('B')), manifest: manifestOf() });
      // Another writer (e.g. `enigma set --depository env`) changes the file between planning and executing.
      writeFileSync(envPath(), `${envBlock('A=envblock-a')}${block('STALE=1')}`, { mode: 0o600 });
      const outcome = await executeRender(plan, { actor: 'cli', projectId: PID, worktree: project, resolveValue: fixedValues({ A: 'a', B: 'b' }) });
      expect(read()).toBe(`${envBlock('A=envblock-a')}${block('B=b')}`);
      expect(outcome.alreadyInEnvBlock).toEqual(['A']);
      expect(outcome.removed).toEqual(['STALE']);
    });

    it('a previously rendered name whose entry is gone is dropped from the block and the ledger', async () => {
      writeFileSync(envPath(), `USER=1\n${block('GONE=old', 'A=old-a')}`, { mode: 0o600 });
      const outcome = await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'new-a' }) });
      expect(outcome.removed).toEqual(['GONE']);
      expect(read()).toBe(`USER=1\n${block('A=new-a')}`);
      expect(readLedger().targets[0]?.names).toEqual(['A']);
    });
  });

  describe('[r1.5] ledger and audit tell the truth', () => {
    it('a name that failed and had no previous line is not in the block, not in the ledger, and is audited ok:false', async () => {
      const outcome = await run({ index: indexOf(entry('GOOD'), entry('BAD')), resolve: fixedValues({ GOOD: 'g' }) });
      expect(readLedger().targets[0]?.names).toEqual(['GOOD']);
      expect(read()).toBe(block('GOOD=g'));
      expect(audits().map((a) => [a.name, a.ok])).toEqual([['GOOD', true], ['BAD', false]]);
      expect(outcome.rendered).toEqual(['GOOD']);
      expect(outcome.failed).toEqual([expect.objectContaining({ name: 'BAD', keptPreviousLine: false })]);
    });

    it('a failed name that had a previous line keeps it, is in the ledger, and is audited ok:false', async () => {
      writeFileSync(envPath(), block('KEY=prior'), { mode: 0o600 });
      const outcome = await run({ index: indexOf(entry('KEY')), resolve: fixedValues({}) });
      expect(read()).toBe(block('KEY=prior'));
      expect(readLedger().targets[0]?.names).toEqual(['KEY']);
      expect(audits().map((a) => [a.name, a.ok])).toEqual([['KEY', false]]);
      expect(outcome.failed).toEqual([expect.objectContaining({ name: 'KEY', keptPreviousLine: true })]);
    });

    it('when every name fails and nothing was rendered before, no file and no ledger row appear', async () => {
      await run({ index: indexOf(entry('BAD')), resolve: fixedValues({}) });
      expect(existsSync(envPath())).toBe(false);
      expect(readLedger().targets).toEqual([]);
    });

    describe('a failed atomic write', () => {
      let blocked: string;
      beforeEach(() => {
        blocked = join(project, 'blocked');
        mkdirSync(blocked, { mode: 0o700 });
        chmodSync(blocked, 0o500);
      });
      afterEach(() => chmodSync(blocked, 0o700));

      it('leaves the ledger untouched, audits every attempted name ok:false, reports nothing rendered, and sets writeError', async () => {
        const target = join(blocked, '.env');
        upsertTarget({ projectId: PID, worktree: project, file: target, names: ['PRE'] });
        const before = readLedger();
        const outcome = await run({
          index: indexOf(entry('A'), entry('B')),
          manifest: manifestOf({ render: { path: 'blocked/.env' } }),
          resolve: fixedValues({ A: 'a', B: 'b' }),
        });
        expect(readLedger()).toEqual(before);
        expect(audits().map((a) => [a.name, a.ok])).toEqual([['A', false], ['B', false]]);
        expect(existsSync(target)).toBe(false);
        expect(outcome.rendered).toEqual([]);
        expect(outcome.removed).toEqual([]);
        expect(outcome.failed.map((f) => [f.name, f.errorCode])).toEqual([['A', 'E_WRITE_FAILED'], ['B', 'E_WRITE_FAILED']]);
        expect(outcome.writeError).toBe('failed to rewrite the target file (EACCES)');
      });

      it('reports keptPreviousLine for a name whose old line is still in the untouched file', async () => {
        const target = join(blocked, '.env');
        chmodSync(blocked, 0o700);
        writeFileSync(target, block('OLD=1'), { mode: 0o600 });
        chmodSync(blocked, 0o500);
        const outcome = await run({
          index: indexOf(entry('OLD'), entry('NEW')),
          manifest: manifestOf({ render: { path: 'blocked/.env' } }),
          resolve: fixedValues({ OLD: 'x', NEW: 'y' }),
        });
        expect(outcome.failed.map((f) => [f.name, f.keptPreviousLine])).toEqual([['OLD', true], ['NEW', false]]);
        expect(read(target)).toBe(block('OLD=1'));
      });
    });
  });

  describe('[r1.6] failure reasons are static', () => {
    it('an EnigmaError message carrying a value is never copied into the outcome, the audit log or the ledger', async () => {
      const resolve: Resolver = async () => {
        throw new EnigmaError({ code: 'E_NOT_FOUND', message: `lookup failed, secret=${SENTINEL}` });
      };
      const outcome = await run({ index: indexOf(entry('A')), resolve });
      expect(outcome.failed).toEqual([{ name: 'A', errorCode: 'E_NOT_FOUND', reason: 'failed to resolve: not found', keptPreviousLine: false }]);
      for (const bytes of [JSON.stringify(outcome), read(auditLogPath()), JSON.stringify(readLedger())]) expect(bytes).not.toContain(SENTINEL);
    });

    it('a non-Enigma error gets a generic reason and its message is never used', async () => {
      const outcome = await run({
        index: indexOf(entry('A')),
        resolve: async () => { throw new Error(`boom ${SENTINEL}`); },
      });
      expect(outcome.failed[0]).toMatchObject({ errorCode: 'E_UNKNOWN', reason: 'failed to resolve: unknown error' });
      expect(JSON.stringify(outcome)).not.toContain(SENTINEL);
      expect(read(auditLogPath())).not.toContain(SENTINEL);
    });

    it('an error code without a fixed string gets a generic reason naming the code', async () => {
      const outcome = await run({
        index: indexOf(entry('A')),
        resolve: async () => { throw new EnigmaError({ code: 'E_LOCK_TIMEOUT', message: `secret ${SENTINEL}` }); },
      });
      expect(outcome.failed[0]?.reason).toBe('failed to resolve (E_LOCK_TIMEOUT)');
    });

    it('the value appears in the target file only, never in the audit log or the ledger', async () => {
      await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: SENTINEL }) });
      expect(read()).toContain(SENTINEL);
      expect(read(auditLogPath())).not.toContain(SENTINEL);
      expect(JSON.stringify(readLedger())).not.toContain(SENTINEL);
    });
  });

  describe('[r1.10] empty render set', () => {
    it('with no existing block, a missing file is not created and no ledger row appears', async () => {
      const outcome = await run({ index: indexOf() });
      expect(existsSync(envPath())).toBe(false);
      expect(outcome.rendered).toEqual([]);
      expect(readLedger().targets).toEqual([]);
    });

    it('with no existing block, an existing file is left byte-identical', async () => {
      const original = 'USER_LINE=1\nNO_TRAILING_NEWLINE=2';
      writeFileSync(envPath(), original, { mode: 0o600 });
      await run({ index: indexOf() });
      expect(read()).toBe(original);
    });

    it('an existing block that would become empty is removed, markers included, outside bytes preserved, and the ledger row is dropped', async () => {
      writeFileSync(envPath(), `USER_LINE=1\n${envBlock('E=1')}${block('ONLY=old')}TAIL=2\n`, { mode: 0o600 });
      upsertTarget({ projectId: PID, worktree: project, file: envPath(), names: ['ONLY'] });
      const outcome = await run({ index: indexOf() });
      expect(read()).toBe(`USER_LINE=1\n${envBlock('E=1')}TAIL=2\n`);
      expect(outcome.removed).toEqual(['ONLY']);
      expect(readLedger().targets).toEqual([]);
    });

    it('a block that was the file\'s whole content leaves an empty file', async () => {
      writeFileSync(envPath(), block('ONLY=old'), { mode: 0o600 });
      await run({ index: indexOf() });
      expect(read()).toBe('');
    });
  });

  describe('[r1.11] output labels', () => {
    it('a failed name that kept its previous line is under failed, not kept', async () => {
      writeFileSync(envPath(), block('KEEP=k-old', 'KEY=prior'), { mode: 0o600 });
      const outcome = await run({ index: indexOf(entry('KEY'), entry('KEEP', 'keychain')), resolve: fixedValues({}) });
      expect(outcome.failed.map((f) => f.name)).toEqual(['KEY']);
      expect(outcome.kept).toEqual(['KEEP']);
    });

    it('a name narrowed out by render.names that had been rendered appears once, under removed', async () => {
      writeFileSync(envPath(), block('A=old-a', 'B=old-b'), { mode: 0o600 });
      const outcome = await run({ index: indexOf(entry('A'), entry('B')), manifest: manifestOf({ render: { names: ['A'] } }), resolve: fixedValues({ A: 'a' }) });
      expect(outcome.removed).toEqual(['B']);
      expect(outcome.skipped).toEqual([]);
      expect(read()).toBe(block('A=a'));
    });

    it('a name narrowed out that was never rendered appears once, under skipped', async () => {
      const outcome = await run({ index: indexOf(entry('A'), entry('B')), manifest: manifestOf({ render: { names: ['A'] } }), resolve: fixedValues({ A: 'a' }) });
      expect(outcome.skipped).toEqual([{ name: 'B', reason: 'narrowed-out' }]);
      expect(outcome.removed).toEqual([]);
    });
  });

  describe('[r1.7] explicit render reports failures', () => {
    it('a failed explicit render reports the name with a static reason, writes nothing, and leaves rendered empty', async () => {
      const outcome = await run({ index: indexOf(entry('BAD')), explicitName: 'BAD', resolve: fixedValues({}) });
      expect(outcome.failed).toEqual([expect.objectContaining({ name: 'BAD', reason: 'failed to resolve: not found' })]);
      expect(outcome.rendered).toEqual([]);
      expect(existsSync(envPath())).toBe(false);
    });
  });
});

describe('[r1.8] checkEnvGitignore target parameter', () => {
  const ignoreDir = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-gitignore-')));
    return dir;
  };

  it('the default target behaves exactly as before: `.env` covered → no warning; not covered → the `.env` warning; no file → the no-file warning', () => {
    const dir = ignoreDir();
    expect(checkEnvGitignore(dir)).toEqual(['.env is not gitignored: no .gitignore file found in this project']);
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    expect(checkEnvGitignore(dir)).toEqual(['.env is not gitignored: add .env to .gitignore before committing']);
    writeFileSync(join(dir, '.gitignore'), '/.env\n');
    expect(checkEnvGitignore(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a custom target is checked by its own path: covering `.env` does not cover `config/local.env`', () => {
    const dir = ignoreDir();
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    expect(checkEnvGitignore(dir, 'config/local.env')).toEqual(['config/local.env is not gitignored: add config/local.env to .gitignore before committing']);
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['config/local.env', 'config/local.env'],
    ['*.env', 'config/local.env'],
    ['local.env', 'config/local.env'],
    ['config/', 'config/local.env'],
    ['**/local.env', 'config/local.env'],
    ['.env.*', '.env.local'],
    ['/.env.local', '.env.local'],
  ])('pattern %s covers %s', (pattern, target) => {
    const dir = ignoreDir();
    writeFileSync(join(dir, '.gitignore'), `${pattern}\n`);
    expect(checkEnvGitignore(dir, target)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['other/local.env', 'config/local.env'],
    ['/local.env', 'config/local.env'],
    ['!config/local.env', 'config/local.env'],
    ['config/local.env/', 'config/other.env'],
  ])('pattern %s does not cover %s', (pattern, target) => {
    const dir = ignoreDir();
    writeFileSync(join(dir, '.gitignore'), `${pattern}\n`);
    expect(checkEnvGitignore(dir, target)).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('[r2.1] the target is re-validated under the lock', () => {
  it('a parent directory swapped for a symlink out of the worktree while values resolve: nothing is written outside, the run fails, the ledger is unchanged, and the attempted names are audited ok:false', async () => {
    mkdirSync(join(project, 'sub'));
    const outside = join(home, 'outside');
    mkdirSync(outside);
    const swap: Resolver = async () => {
      rmSync(join(project, 'sub'), { recursive: true });
      symlinkSync(outside, join(project, 'sub'));
      return SENTINEL;
    };
    await expect(run({ index: indexOf(entry('A')), manifest: manifestOf({ render: { path: 'sub/.env' } }), resolve: swap })).rejects.toMatchObject({
      code: 'E_WRITE_FAILED',
      message: expect.stringContaining('outside the worktree'),
    });
    expect(readdirSync(outside)).toEqual([]);
    expect(readLedger().targets).toEqual([]);
    expect(audits().map((a) => [a.name, a.ok])).toEqual([['A', false]]);
    expect(read(auditLogPath())).not.toContain(SENTINEL);
  });

  it('the target swapped for a directory while values resolve is refused, not a raw EISDIR', async () => {
    const swap: Resolver = async () => {
      mkdirSync(envPath());
      return 'v';
    };
    await expect(run({ index: indexOf(entry('A')), resolve: swap })).rejects.toMatchObject({ code: 'E_WRITE_FAILED', message: expect.stringContaining('not a regular file') });
    expect(audits().map((a) => [a.name, a.ok])).toEqual([['A', false]]);
  });

  it('the lock is released after a refusal', async () => {
    mkdirSync(envPath());
    await expect(run({ index: indexOf(entry('A')) })).rejects.toBeDefined();
    acquireFileLock(renderLockPath(envPath())).release();
  });
});

describe('[r2.2] line order', () => {
  it('an explicit render keeps the existing lines in their current order and appends the new name last', async () => {
    writeFileSync(envPath(), block('Z=zz', 'A=aa'), { mode: 0o600 });
    await run({ index: indexOf(entry('A'), entry('B'), entry('Z')), explicitName: 'B', resolve: fixedValues({ B: 'bb' }) });
    expect(read()).toBe(block('Z=zz', 'A=aa', 'B=bb'));
  });

  it('an explicit render of an existing name updates it in its position', async () => {
    writeFileSync(envPath(), block('Z=old', 'A=aa'), { mode: 0o600 });
    await run({ index: indexOf(entry('A'), entry('Z')), explicitName: 'Z', resolve: fixedValues({ Z: 'new' }) });
    expect(read()).toBe(block('Z=new', 'A=aa'));
  });

  it('a plain re-render of an unsorted block with unchanged values is byte-identical', async () => {
    const original = `USER=1\n${block('Z=zz', 'A=aa', 'M=mm')}TAIL=2\n`;
    writeFileSync(envPath(), original, { mode: 0o600 });
    await run({ index: indexOf(entry('A'), entry('M'), entry('Z')), resolve: fixedValues({ A: 'aa', M: 'mm', Z: 'zz' }) });
    expect(read()).toBe(original);
  });

  it('a plain render appends new names after the existing lines, sorted among themselves; a dropped name leaves the order of the rest alone', async () => {
    writeFileSync(envPath(), block('Z=zz', 'GONE=x', 'A=aa'), { mode: 0o600 });
    await run({ index: indexOf(entry('A'), entry('Z'), entry('D'), entry('C')), resolve: fixedValues({ A: 'aa', Z: 'zz', D: 'dd', C: 'cc' }) });
    expect(read()).toBe(block('Z=zz', 'A=aa', 'C=cc', 'D=dd'));
  });

  it('a kept prompting-store line stays in its position', async () => {
    writeFileSync(envPath(), block('Z=zz', 'KC=kk'), { mode: 0o600 });
    await run({ index: indexOf(entry('Z'), entry('KC', 'keychain'), entry('A')), resolve: fixedValues({ Z: 'zz', A: 'aa' }) });
    expect(read()).toBe(block('Z=zz', 'KC=kk', 'A=aa'));
  });
});

describe('[r2.4] removing the block restores the bytes outside it', () => {
  // A file with no trailing newline keeps the one EOL the block needed (see [r3.1]); every other shape is restored exactly.
  it.each([
    ['no trailing newline (one EOL remains)', 'U=1', 'U=1\n'],
    ['a trailing newline', 'U=1\n', 'U=1\n'],
    ['CRLF, no trailing newline (one CRLF remains)', 'U=1\r\nV=2', 'U=1\r\nV=2\r\n'],
    ['CRLF, trailing newline', 'U=1\r\nV=2\r\n', 'U=1\r\nV=2\r\n'],
    ['an empty file', '', ''],
  ])('render then empty the set: %s', async (_label, original, afterStrip) => {
    writeFileSync(envPath(), original, { mode: 0o600 });
    await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a' }) });
    expect(read().startsWith(original)).toBe(true);
    expect(read()).not.toBe(original);
    await run({ index: indexOf() });
    expect(read()).toBe(afterStrip);
  });

  it('a block in the middle of a file is removed without touching either side', async () => {
    writeFileSync(envPath(), `U=1\n${block('A=a')}TAIL=2`, { mode: 0o600 });
    await run({ index: indexOf() });
    expect(read()).toBe('U=1\nTAIL=2');
  });
});

describe('[r3] fix batch round 3', () => {
  describe('[r3.1] the block always ends with an EOL', () => {
    it.each([
      ['no trailing newline', 'U=1'],
      ['a trailing newline', 'U=1\n'],
      ['CRLF, no trailing newline', 'U=1\r\nV=2'],
      ['an empty file', ''],
    ])('a rendered file ends with an EOL: %s', async (_label, original) => {
      writeFileSync(envPath(), original, { mode: 0o600 });
      await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a' }) });
      expect(read()).toMatch(/\r?\n$/);
    });

    it('an `echo NEW=1 >>` after a render lands on its own line: NEW parses, the rendered name is not importable, and a re-render leaves exactly one block', async () => {
      writeFileSync(envPath(), 'U=1', { mode: 0o600 });
      await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a' }) });
      writeFileSync(envPath(), `${read()}NEW=1\n`, { mode: 0o600 });

      expect(parseDotEnv(read()).entries.map((e) => e.name)).toEqual(['U', 'NEW']);
      await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a2' }) });
      const content = read();
      expect(content.split(RENDER_BEGIN_MARKER).length - 1).toBe(1);
      expect(content.split(RENDER_END_MARKER).length - 1).toBe(1);
      expect(content).toContain('NEW=1\n');
      expect(content).toContain('A=a2');
    });
  });

  describe('[r3.2] a damaged render block is refused', () => {
    it.each([
      ['an end marker with text glued on', `U=1\n${RENDER_BEGIN_MARKER}\nA=old\n${RENDER_END_MARKER}NEW=1\n`],
      ['no end marker at all', `U=1\n${RENDER_BEGIN_MARKER}\nA=old\n`],
    ])('%s: fails naming the file, resolves nothing, writes nothing, leaves the ledger alone', async (_label, damaged) => {
      writeFileSync(envPath(), damaged, { mode: 0o600 });
      let resolves = 0;
      await expect(run({ index: indexOf(entry('A')), resolve: async () => { resolves++; return 'v'; } })).rejects.toMatchObject({
        code: 'E_WRITE_FAILED',
        message: expect.stringMatching(new RegExp(`${envPath().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*damaged.*"# enigma:render:end"`)),
      });
      expect(resolves).toBe(0);
      expect(read()).toBe(damaged);
      expect(readLedger().targets).toEqual([]);
    });

    it('a block damaged between the unlocked read and the lock is refused too, audited ok:false', async () => {
      writeFileSync(envPath(), block('A=old'), { mode: 0o600 });
      const damage: Resolver = async () => {
        writeFileSync(envPath(), `${RENDER_BEGIN_MARKER}\nA=old\n${RENDER_END_MARKER}NEW=1\n`, { mode: 0o600 });
        return 'v';
      };
      await expect(run({ index: indexOf(entry('A')), resolve: damage })).rejects.toMatchObject({ code: 'E_WRITE_FAILED' });
      expect(audits().map((a) => [a.name, a.ok])).toEqual([['A', false]]);
      expect(read().split(RENDER_BEGIN_MARKER).length - 1).toBe(1);
    });
  });

  describe('[r3.4] enabled is checked before the path', () => {
    it.each(['/etc/passwd', '../escape.env', 'no-such-dir/.env', ''])('render.enabled=false with render.path %j plans as disabled and does not throw', (path) => {
      const plan = buildRenderPlan({ cwd: project, projectId: PID, worktree: project, index: indexOf(entry('A')), manifest: manifestOf({ render: { enabled: false, path } }) });
      expect(plan.enabled).toBe(false);
      expect(plan.toResolve).toEqual([]);
    });

    it('executing a disabled plan with an invalid path is a no-op', async () => {
      const outcome = await run({ index: indexOf(entry('A')), manifest: manifestOf({ render: { enabled: false, path: '/etc/passwd' } }) });
      expect(outcome.disabled).toBe(true);
    });
  });

  describe('[r3.5] names already in the env block are not resolved', () => {
    it('an explicit render of an env-block name never calls the resolver', async () => {
      writeFileSync(envPath(), envBlock('A=envblock-a'), { mode: 0o600 });
      let resolves = 0;
      const outcome = await run({ index: indexOf(entry('A', 'keychain')), explicitName: 'A', resolve: async () => { resolves++; return 'x'; } });
      expect(resolves).toBe(0);
      expect(outcome.alreadyInEnvBlock).toEqual(['A']);
      expect(read()).toBe(envBlock('A=envblock-a'));
    });

    it('a plain render resolves only the names that are not in the env block', async () => {
      writeFileSync(envPath(), envBlock('A=envblock-a'), { mode: 0o600 });
      const asked: string[] = [];
      await run({ index: indexOf(entry('A'), entry('B')), resolve: async (name) => { asked.push(name); return 'v'; } });
      expect(asked).toEqual(['B']);
    });

    it('a name skipped because of the unlocked read but no longer in the env block on the locked read fails with a static reason instead of being guessed', async () => {
      writeFileSync(envPath(), envBlock('A=envblock-a'), { mode: 0o600 });
      const dropEnvBlock: Resolver = async () => {
        writeFileSync(envPath(), 'USER=1\n', { mode: 0o600 });
        return 'v';
      };
      const outcome = await run({ index: indexOf(entry('A'), entry('B')), resolve: dropEnvBlock });
      expect(outcome.failed).toEqual([
        { name: 'A', errorCode: 'E_TARGET_CHANGED', reason: 'not resolved: the target file changed while rendering; run enigma render again', keptPreviousLine: false },
      ]);
      expect(read()).toBe(`USER=1\n${block('B=v')}`);
    });
  });

  describe('[r3.6] the ledger and the report use the canonical target path', () => {
    it('an in-worktree symlinked parent directory: the ledger file and the reported file are the real path that was written', async () => {
      mkdirSync(join(project, 'realdir'));
      symlinkSync(join(project, 'realdir'), join(project, 'link'));
      const outcome = await run({ index: indexOf(entry('A')), manifest: manifestOf({ render: { path: 'link/.env' } }), resolve: fixedValues({ A: 'a' }) });
      const real = join(project, 'realdir', '.env');
      expect(read(real)).toBe(block('A=a'));
      expect(outcome.file).toBe(real);
      expect(readLedger().targets.map((t) => t.file)).toEqual([real]);
    });
  });

  it('[r3.8] `./.` gets the "must name a file" message, not the symlinked-parent one', () => {
    expect(() => buildRenderPlan({ cwd: project, projectId: PID, worktree: project, index: indexOf(), manifest: manifestOf({ render: { path: './.' } }) })).toThrow(
      expect.objectContaining({ code: 'E_WRITE_FAILED', message: expect.stringContaining('must name a file') }),
    );
  });
});

describe('[r4] fix batch round 4', () => {
  describe('[r4.1] an existing block at EOF without a newline is terminated on re-render', () => {
    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ])('%s: the block ends with an EOL afterwards, and an appended NEW=1 is its own variable while the rendered name is not importable', async (_label, eol) => {
      const unterminated = `U=1${eol}${RENDER_BEGIN_MARKER}${eol}A=old${eol}${RENDER_END_MARKER}`;
      writeFileSync(envPath(), unterminated, { mode: 0o600 });

      await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a2' }) });
      expect(read()).toBe(`U=1${eol}${RENDER_BEGIN_MARKER}${eol}A=a2${eol}${RENDER_END_MARKER}${eol}`);

      writeFileSync(envPath(), `${read()}NEW=1${eol}`, { mode: 0o600 });
      expect(parseDotEnv(read()).entries.map((e) => e.name)).toEqual(['U', 'NEW']);
      await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a3' }) });
      expect(read().split(RENDER_BEGIN_MARKER).length - 1).toBe(1);
      expect(read()).toContain('NEW=1');
    });

    it('a block updated in place mid-file is not given extra EOLs', async () => {
      const original = `U=1\n${block('A=old')}TAIL=2`;
      writeFileSync(envPath(), original, { mode: 0o600 });
      await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'new' }) });
      expect(read()).toBe(`U=1\n${block('A=new')}TAIL=2`);
    });
  });

  describe('[r4.2] every render marker is scanned', () => {
    it.each([
      ['a valid block then a second unterminated begin', `${block('R=old')}${RENDER_BEGIN_MARKER}\nB=old\n`],
      ['a stray end marker', `U=1\n${RENDER_END_MARKER}\n`],
      ['a valid block then a stray end marker', `${block('R=old')}${RENDER_END_MARKER}\n`],
      ['two complete blocks', `${block('R=old')}U=1\n${block('S=old')}`],
      ['a nested begin', `${RENDER_BEGIN_MARKER}\nA=1\n${RENDER_BEGIN_MARKER}\nB=1\n${RENDER_END_MARKER}\n`],
    ])('%s: refused, nothing resolved, nothing written, ledger unchanged', async (_label, damaged) => {
      writeFileSync(envPath(), damaged, { mode: 0o600 });
      let resolves = 0;
      await expect(run({ index: indexOf(entry('A')), resolve: async () => { resolves++; return 'v'; } })).rejects.toMatchObject({
        code: 'E_WRITE_FAILED',
        message: expect.stringContaining('damaged'),
      });
      expect(resolves).toBe(0);
      expect(read()).toBe(damaged);
      expect(readLedger().targets).toEqual([]);
    });

    it('a file with exactly one well-formed block still renders', async () => {
      writeFileSync(envPath(), `U=1\n${block('R=old')}`, { mode: 0o600 });
      await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a' }) });
      expect(read()).toBe(`U=1\n${block('A=a')}`);
    });
  });

  describe('[r4.4] the lock is keyed on the validated canonical path', () => {
    it('two lexical spellings of one target give the same lock path', () => {
      mkdirSync(join(project, 'realdir'));
      symlinkSync(join(project, 'realdir'), join(project, 'link'));
      expect(renderLockPath(join(project, 'link', '.env'))).toBe(renderLockPath(join(project, 'realdir', '.env')));
    });

    it('an in-worktree symlinked parent repointed to another in-worktree directory while values resolve is refused, not written', async () => {
      const dirA = join(project, 'a');
      const dirB = join(project, 'b');
      mkdirSync(dirA);
      mkdirSync(dirB);
      symlinkSync(dirA, join(project, 'link'));
      const repoint: Resolver = async () => {
        rmSync(join(project, 'link'));
        symlinkSync(dirB, join(project, 'link'));
        return 'v';
      };
      await expect(run({ index: indexOf(entry('A')), manifest: manifestOf({ render: { path: 'link/.env' } }), resolve: repoint })).rejects.toMatchObject({
        code: 'E_WRITE_FAILED',
        message: expect.stringContaining('different file'),
      });
      expect(readdirSync(dirB)).toEqual([]);
      expect(readdirSync(dirA)).toEqual([]);
      expect(readLedger().targets).toEqual([]);
      expect(audits().map((a) => [a.name, a.ok])).toEqual([['A', false]]);
    });
  });
});

describe('[r5] one conservative rule for render markers', () => {
  const damagedCase = async (damaged: string): Promise<void> => {
    writeFileSync(envPath(), damaged, { mode: 0o600 });
    let resolves = 0;
    await expect(run({ index: indexOf(entry('A')), resolve: async () => { resolves++; return 'v'; } })).rejects.toMatchObject({
      code: 'E_WRITE_FAILED',
      message: expect.stringContaining('damaged'),
    });
    expect(resolves).toBe(0);
    expect(read()).toBe(damaged);
    expect(readLedger().targets).toEqual([]);
  };

  it('(a) the nested shape BEGIN / A / BEGIN / B / END / TAIL is refused', async () => {
    await damagedCase(`${RENDER_BEGIN_MARKER}\nA=1\n${RENDER_BEGIN_MARKER}\nB=1\n${RENDER_END_MARKER}\nTAIL=2\n`);
  });

  it('(c) render begin, env begin, render end, env end is refused; the file is unchanged and the env value is still there', async () => {
    const damaged = `${RENDER_BEGIN_MARKER}\nR=old\n${ENV_BEGIN_MARKER}\nE=stored\n${RENDER_END_MARKER}\n${ENV_END_MARKER}\n`;
    await damagedCase(damaged);
    expect(read()).toContain('E=stored');
  });

  it('(d) env begin, render begin, env end, render end is refused; the file is unchanged and the env value is still there', async () => {
    const damaged = `${ENV_BEGIN_MARKER}\nE=stored\n${RENDER_BEGIN_MARKER}\nR=old\n${ENV_END_MARKER}\n${RENDER_END_MARKER}\n`;
    await damagedCase(damaged);
    expect(read()).toContain('E=stored');
  });

  it('(e) a stray end marker alone is damaged for the renderer too', async () => {
    await damagedCase(`U=1\n${RENDER_END_MARKER}\n`);
  });

  it('a stray end marker followed by a well-formed block is refused', async () => {
    await damagedCase(`${RENDER_END_MARKER}\n${block('R=old')}`);
  });

  it('an env block wholly outside the render block is fine and stays byte-identical', async () => {
    writeFileSync(envPath(), `${envBlock('E=stored')}${block('R=old')}`, { mode: 0o600 });
    await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a' }) });
    expect(read()).toBe(`${envBlock('E=stored')}${block('A=a')}`);
  });

  describe('(b) markers with trailing whitespace are recognized', () => {
    it.each([
      ['spaces and a tab', `${RENDER_BEGIN_MARKER}  `, `${RENDER_END_MARKER}\t`, '\n'],
      ['CRLF file, markers with trailing spaces', `${RENDER_BEGIN_MARKER} `, `${RENDER_END_MARKER} `, '\r\n'],
    ])('%s: the block is found (not a second block appended) and rewritten with canonical markers', async (_label, begin, end, eol) => {
      writeFileSync(envPath(), `U=1${eol}${begin}${eol}A=old${eol}${end}${eol}TAIL=2${eol}`, { mode: 0o600 });
      await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a2' }) });
      const canonical = `${RENDER_BEGIN_MARKER}${eol}A=a2${eol}${RENDER_END_MARKER}${eol}`;
      expect(read()).toBe(`U=1${eol}${canonical}TAIL=2${eol}`);
    });

    it('a whitespace-marker block whose set becomes empty is removed', async () => {
      writeFileSync(envPath(), `U=1\n${RENDER_BEGIN_MARKER} \nA=old\n${RENDER_END_MARKER} \nTAIL=2\n`, { mode: 0o600 });
      await run({ index: indexOf() });
      expect(read()).toBe('U=1\nTAIL=2\n');
    });

    it('whitespace markers with a second block are refused like any repeated block', async () => {
      await damagedCase(`${RENDER_BEGIN_MARKER} \nA=1\n${RENDER_END_MARKER}\n${block('B=1')}`);
    });
  });

  describe('a stripped block leaves the file ending with an EOL', () => {
    it.each([
      ['LF', '\n', 'U=1\nBEGIN\nA=old\nEND', 'U=1\n'],
      ['CRLF', '\r\n', 'U=1\r\nV=2\r\nBEGIN\r\nA=old\r\nEND', 'U=1\r\nV=2\r\n'],
      ['an emptied file stays empty', '\n', 'BEGIN\nA=old\nEND', ''],
      ['an emptied file with a trailing newline stays empty', '\n', 'BEGIN\nA=old\nEND\n', ''],
    ])('a hand-edited block at EOF without a newline (%s)', async (_label, eol, before, after) => {
      const withMarkers = before.replace('BEGIN', RENDER_BEGIN_MARKER).replace('END', RENDER_END_MARKER);
      writeFileSync(envPath(), withMarkers, { mode: 0o600 });
      await run({ index: indexOf() });
      expect(read()).toBe(after);
      expect(eol).toBeDefined();
    });
  });
});

describe('[r6] physical lines: files with mixed line endings', () => {
  const RB = RENDER_BEGIN_MARKER;
  const RE = RENDER_END_MARKER;
  const EB = ENV_BEGIN_MARKER;
  const EE = ENV_END_MARKER;

  it('an LF file with one CRLF line at the end: exactly one block, stale content replaced, every other byte identical', async () => {
    writeFileSync(envPath(), `U=1\n${RB}\nA=old\n${RE}\nW=2\r\n`, { mode: 0o600 });
    await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'new' }) });
    expect(read()).toBe(`U=1\n${RB}\nA=new\n${RE}\nW=2\r\n`);
  });

  it('marker lines that end in CR inside an otherwise LF file: the block is found, not a second one appended', async () => {
    writeFileSync(envPath(), `U=1\n${RB}\r\nA=old\r\n${RE}\r\nW=2\n`, { mode: 0o600 });
    await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'new' }) });
    const content = read();
    expect(content.split(RB).length - 1).toBe(1);
    // untouched lines keep their own terminators; the rewritten block uses the dominant EOL (CRLF here: 3 CRLF vs 2 LF)
    expect(content).toBe(`U=1\n${RB}\r\nA=new\r\n${RE}\r\nW=2\n`);
  });

  it('a mixed file with an env block: every outside line keeps its terminator byte for byte after a render, the env value is untouched, and a name in the env block is not duplicated', async () => {
    const original = `E1=x\r\n${EB}\nA=envblock-a\r\n${EE}\nU=1\r\n`;
    writeFileSync(envPath(), original, { mode: 0o600 });
    const outcome = await run({ index: indexOf(entry('A'), entry('B')), resolve: fixedValues({ A: 'a', B: 'b' }) });
    expect(outcome.alreadyInEnvBlock).toEqual(['A']);
    // 3 CRLF vs 2 LF: the appended block is CRLF
    expect(read()).toBe(`${original}${RB}\r\nB=b\r\n${RE}\r\n`);
  });

  it('the dominant EOL is LF on a tie, and an unterminated last line is terminated in it before a block is appended', async () => {
    writeFileSync(envPath(), 'A=1\r\nB=2\nC=3', { mode: 0o600 });
    await run({ index: indexOf(entry('N')), resolve: fixedValues({ N: 'n' }) });
    expect(read()).toBe(`A=1\r\nB=2\nC=3\n${RB}\nN=n\n${RE}\n`);
  });

  it('a mixed file: stripping the block leaves the other lines byte-identical', async () => {
    writeFileSync(envPath(), `U=1\r\n${RB}\nA=old\n${RE}\nW=2\n`, { mode: 0o600 });
    await run({ index: indexOf() });
    expect(read()).toBe('U=1\r\nW=2\n');
  });

  it('a block inside an env block is DAMAGED: refused, the file is unchanged, the env value is intact', async () => {
    const damaged = `${EB}\nE=stored\n${RB}\nR=old\n${RE}\n${EE}\n`;
    writeFileSync(envPath(), damaged, { mode: 0o600 });
    let resolves = 0;
    await expect(run({ index: indexOf(entry('A')), resolve: async () => { resolves++; return 'v'; } })).rejects.toMatchObject({
      code: 'E_WRITE_FAILED',
      message: expect.stringContaining('damaged'),
    });
    expect(resolves).toBe(0);
    expect(read()).toBe(damaged);
    expect(read()).toContain('E=stored');
    expect(readLedger().targets).toEqual([]);
  });

  it('a render block wholly outside an env block is still well-formed (before or after it)', async () => {
    writeFileSync(envPath(), `${block('R=old')}${envBlock('E=stored')}`, { mode: 0o600 });
    await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a' }) });
    expect(read()).toBe(`${block('A=a')}${envBlock('E=stored')}`);
  });
});

describe('[r7] env blocks: the union of exact and trimmed recognition', () => {
  const EB = ENV_BEGIN_MARKER;
  const EE = ENV_END_MARKER;

  it('probed shape 1 (`EB\\r\\r\\n`): a name in that env block is reported as already there, not duplicated into the render block', async () => {
    const original = `${EB}\r\r\nE=stored\n${EE}\nU=1\n`;
    writeFileSync(envPath(), original, { mode: 0o600 });
    const outcome = await run({ index: indexOf(entry('A'), entry('E')), resolve: fixedValues({ A: 'a', E: 'from-store' }) });
    expect(outcome.alreadyInEnvBlock).toEqual(['E']);
    expect(read()).toBe(`${original}${RENDER_BEGIN_MARKER}\nA=a\n${RENDER_END_MARKER}\n`);
  });

  it.each([
    ['a begin with trailing spaces', `${EB}  \nE=stored\n${EE}\nU=1\n`],
    ['an end with a trailing tab', `${EB}\nE=stored\n${EE}\t\nU=1\n`],
    ['an end with an extra CR', `${EB}\nE=stored\n${EE}\r\r\nU=1\n`],
  ])('%s: the env name is still recognized for dedupe', async (_label, original) => {
    writeFileSync(envPath(), original, { mode: 0o600 });
    const outcome = await run({ index: indexOf(entry('E')), resolve: fixedValues({ E: 'from-store' }) });
    expect(outcome.alreadyInEnvBlock).toEqual(['E']);
    expect(read()).toBe(original);
  });

  it('probed shape 2 (EB / EE with a trailing space / RB / RNAME / RE / EE): refused, the file is byte-unchanged, nothing is resolved (the render block used to be deleted)', async () => {
    const damaged = `${EB}\n${EE} \n${RENDER_BEGIN_MARKER}\nRNAME=old\n${RENDER_END_MARKER}\n${EE}\n`;
    writeFileSync(envPath(), damaged, { mode: 0o600 });
    let resolves = 0;
    await expect(run({ index: indexOf(entry('A')), resolve: async () => { resolves++; return 'v'; } })).rejects.toMatchObject({
      code: 'E_WRITE_FAILED',
      message: expect.stringContaining('damaged'),
    });
    expect(resolves).toBe(0);
    expect(read()).toBe(damaged);
    expect(readLedger().targets).toEqual([]);
  });

  it('a render block wholly outside every env range from either view still renders', async () => {
    writeFileSync(envPath(), `${EB}  \nE=stored\n${EE}\n${block('R=old')}`, { mode: 0o600 });
    await run({ index: indexOf(entry('A')), resolve: fixedValues({ A: 'a' }) });
    expect(read()).toBe(`${EB}  \nE=stored\n${EE}\n${block('A=a')}`);
  });
});

describe('[r1.13] cleanups', () => {
  it.each(['src/storage/depositories/env.ts', 'src/storage/dotenv-file.ts', 'src/core/config.ts'])('%s ends with a trailing newline', (file) => {
    const bytes = readFileSync(join(priorCwd, file), 'utf8');
    expect(bytes.endsWith('\n')).toBe(true);
  });
});
