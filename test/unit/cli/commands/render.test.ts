/* CLI tests for `enigma render` (Issue #107, incl. the r1 fix batch).
 *
 * Tests tagged `[rN.k]` pin item k of the r1 fix batch: each one fails on
 * the r0 head (89be7fa) and passes on the fix. Hermetic: ENIGMA_HOME and
 * the worktree are temp dirs, and `resolveSecret` is mocked so no depository
 * store is touched.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #108: `setSecret` now also renders into the worktree's `.env`. These tests use `setSecret`
// as fixture setup and assert on the file or audit log WITHOUT that step, so they opt out of the
// fan-out; the fan-out itself is covered by test/unit/render/fanout*.test.ts.
vi.mock('../../../../src/render/fanout.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/render/fanout.js')>()),
  fanOutSet: async () => [],
  fanOutRemove: async () => [],
}));

const SENTINEL = 'sk-sentinel-value-should-never-appear-7c3a';

const storedValues = new Map<string, string>();
let resolveShouldFail = false;
let onResolve: (() => void) | undefined;

vi.mock('../../../../src/storage/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/storage/manager.js')>();
  return {
    ...actual,
    resolveSecret: vi.fn(async (name: string) => {
      onResolve?.();
      if (resolveShouldFail) throw new Error(`resolve failure for ${name}; secret=${SENTINEL}-in-message`);
      const stored = storedValues.get(name);
      if (stored !== undefined) return stored;
      throw new Error(`no value stored for ${name} in test fixture`);
    }),
    setSecret: vi.fn(async (opts: Parameters<typeof actual.setSecret>[0]) => {
      storedValues.set(opts.name, opts.value);
      return actual.setSecret(opts);
    }),
  };
});

const { cmdRender } = await import('../../../../src/cli/commands/render.js');
const { main } = await import('../../../../src/cli/index.js');
const { setSecret, resolveSecret, listSecrets } = await import('../../../../src/storage/manager.js');
const { auditLogPath } = await import('../../../../src/core/paths.js');
const { readLedger } = await import('../../../../src/render/ledger.js');

describe('cmdRender', () => {
  let tmpHome: string;
  let tmpProject: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    storedValues.clear();
    resolveShouldFail = false;
    onResolve = undefined;
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    originalCwd = process.cwd();
    process.chdir(tmpProject);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const stdoutText = (): string => stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  const stderrText = (): string => stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  const target = (): string => join(tmpProject, '.env');
  const set = (name: string, value: string, depository: 'encrypted' | 'env' = 'encrypted') =>
    setSecret({ name, value, scope: 'project', depository, cwd: tmpProject, actor: 'cli' });

  it('plain render writes the block for every project-scope encrypted secret and never prints a value', async () => {
    await set('OPENAI_API_KEY', SENTINEL);
    await set('OTHER', 'other-value');

    expect(await cmdRender([])).toBe(0);

    const content = readFileSync(target(), 'utf8');
    expect(content).toContain(`OPENAI_API_KEY=${SENTINEL}`);
    expect(content).toContain('OTHER=other-value');
    expect(stdoutText()).toContain('Rendered: OPENAI_API_KEY, OTHER');
    expect(stdoutText() + stderrText()).not.toContain(SENTINEL);
  });

  it('render.enabled=false writes nothing and says rendering is off', async () => {
    await set('A', 'value-a');
    writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { enabled: false } }));

    expect(await cmdRender([])).toBe(0);
    expect(stdoutText()).toContain('rendering is off');
    expect(existsSync(target())).toBe(false);
  });

  it('--json prints one stable JSON object', async () => {
    await set('A', 'value-a');

    expect(await cmdRender(['--json'])).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdoutText()) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['alreadyInEnvBlock', 'disabled', 'failed', 'file', 'kept', 'removed', 'rendered', 'skipped', 'warnings']);
    expect(parsed.rendered).toEqual(['A']);
    expect(parsed.file).toBe(target());
  });

  it('writes one `render` audit line per rendered name; the value never reaches the audit log or the ledger', async () => {
    await set('A', SENTINEL);
    await cmdRender([]);

    const audits = readFileSync(auditLogPath(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { op: string; name: string; ok: boolean }).filter((a) => a.op === 'render');
    expect(audits).toEqual([expect.objectContaining({ name: 'A', ok: true })]);
    expect(readFileSync(auditLogPath(), 'utf8')).not.toContain(SENTINEL);
    expect(JSON.stringify(readLedger())).not.toContain(SENTINEL);
    expect(readLedger().targets[0]?.names).toEqual(['A']);
  });

  it('delegates the resolve to resolveSecret by name only', async () => {
    await set('A', 'value-a');
    await cmdRender([]);
    expect(resolveSecret).toHaveBeenCalled();
    for (const call of (resolveSecret as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SENTINEL);
    }
  });

  it('[r1.1] a name in the env block is reported under "Already in the env block" and not duplicated into the render block', async () => {
    writeFileSync(target(), '# enigma:begin\nA=envblock-a\n# enigma:end\n', { mode: 0o600 });
    await set('A', 'fresh-a');
    await set('B', 'fresh-b');

    expect(await cmdRender([])).toBe(0);
    expect(stdoutText()).toContain('Already in the env block: A');
    expect(stdoutText()).toContain('Rendered: B');
    expect(readFileSync(target(), 'utf8')).toBe('# enigma:begin\nA=envblock-a\n# enigma:end\n# enigma:render:begin\nB=fresh-b\n# enigma:render:end\n');
  });

  it('[r1.1] --json lists the env-block name under alreadyInEnvBlock', async () => {
    writeFileSync(target(), '# enigma:begin\nA=envblock-a\n# enigma:end\n', { mode: 0o600 });
    await set('A', 'fresh-a');
    await set('B', 'fresh-b');

    expect(await cmdRender(['--json'])).toBe(0);
    const parsed = JSON.parse(stdoutText()) as { rendered: string[]; alreadyInEnvBlock: string[] };
    expect(parsed.alreadyInEnvBlock).toEqual(['A']);
    expect(parsed.rendered).toEqual(['B']);
  });

  describe('[r1.7] explicit `enigma render NAME`', () => {
    it('prints the success line only when the line was written', async () => {
      await set('C', 'value-c');
      expect(await cmdRender(['C'])).toBe(0);
      expect(stdoutText()).toContain(`Rendered C to ${target()}.\n`);
      expect(readFileSync(target(), 'utf8')).toContain('C=value-c');
    });

    it('a resolve failure prints a Failed line with a static reason, exits 1, and prints no success line', async () => {
      await set('BAD', 'value');
      resolveShouldFail = true;

      expect(await cmdRender(['BAD'])).toBe(1);
      expect(stdoutText()).toContain('Failed: BAD (E_UNKNOWN: failed to resolve: unknown error)');
      expect(stdoutText()).not.toContain('Rendered');
      expect(stdoutText() + stderrText()).not.toContain(SENTINEL);
      expect(existsSync(target())).toBe(false);
    });

    it('a failure with a previous line says so and exits 1', async () => {
      await set('BAD', 'value');
      writeFileSync(target(), '# enigma:render:begin\nBAD=prior\n# enigma:render:end\n', { mode: 0o600 });
      resolveShouldFail = true;

      expect(await cmdRender(['BAD'])).toBe(1);
      expect(stdoutText()).toContain('Failed: BAD (E_UNKNOWN: failed to resolve: unknown error; kept previous line)');
      expect(readFileSync(target(), 'utf8')).toContain('BAD=prior');
    });

    it('merges: only NAME changes; every other line stays byte-identical', async () => {
      await set('C', 'value-c');
      await set('A', 'value-a-from-store');
      writeFileSync(target(), '# enigma:render:begin\nA=stale-a\nB=stale-b\n# enigma:render:end\n', { mode: 0o600 });

      expect(await cmdRender(['C'])).toBe(0);
      expect(readFileSync(target(), 'utf8')).toBe('# enigma:render:begin\nA=stale-a\nB=stale-b\nC=value-c\n# enigma:render:end\n');
    });

    it('an env-block name says it was not written and exits 0', async () => {
      writeFileSync(target(), '# enigma:begin\nA=envblock-a\n# enigma:end\n', { mode: 0o600 });
      await set('A', 'fresh-a');

      expect(await cmdRender(['A'])).toBe(0);
      expect(stdoutText()).toContain(`A is already in the env block of ${target()}; not written to the render block.`);
      expect(stdoutText()).not.toContain('Rendered');
    });
  });

  it('[r1.5] a failed write exits 1, names the configured target in the message, and leaves the ledger alone', async () => {
    await set('A', 'value-a');
    const blocked = join(tmpProject, 'blocked');
    mkdirSync(blocked, { mode: 0o700 });
    chmodSync(blocked, 0o500);
    writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { path: 'blocked/local.env' } }));
    try {
      expect(await cmdRender([])).toBe(1);
      expect(stdoutText()).toContain('Failed: A (E_WRITE_FAILED: failed to rewrite the target file)');
      expect(stdoutText()).toContain(`${join(blocked, 'local.env')} was not rewritten (failed to rewrite the target file (EACCES)).`);
      expect(stdoutText()).not.toContain('Rendered:');
      expect(readLedger().targets).toEqual([]);
    } finally {
      chmodSync(blocked, 0o700);
    }
  });

  it('exits 1 when a name fails to resolve and the --json failure carries a static reason', async () => {
    await set('A', 'value-a');
    resolveShouldFail = true;

    expect(await cmdRender(['--json'])).toBe(1);
    const parsed = JSON.parse(stdoutText()) as { failed: Array<{ name: string; reason: string }> };
    expect(parsed.failed[0]?.name).toBe('A');
    expect(stdoutText() + stderrText()).not.toContain(SENTINEL);
  });

  describe('[r1.8] gitignore check targets the configured path', () => {
    it('warns about the configured target even though `.env` is ignored', async () => {
      await set('A', 'value-a');
      mkdirSync(join(tmpProject, 'config'));
      writeFileSync(join(tmpProject, '.gitignore'), '.env\n');
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { path: 'config/local.env' } }));

      expect(await cmdRender([])).toBe(0);
      expect(stdoutText()).toContain('warning: config/local.env is not gitignored: add config/local.env to .gitignore before committing');
    });

    it('does not warn when the configured target is ignored, even though `.env` is not', async () => {
      await set('A', 'value-a');
      mkdirSync(join(tmpProject, 'config'));
      writeFileSync(join(tmpProject, '.gitignore'), 'config/local.env\n');
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { path: 'config/local.env' } }));

      expect(await cmdRender([])).toBe(0);
      expect(stdoutText()).not.toContain('not gitignored');
    });

    it('keeps the `.env` warning for the default target', async () => {
      await set('A', 'value-a');
      expect(await cmdRender([])).toBe(0);
      expect(stdoutText()).toContain('warning: .env is not gitignored: no .gitignore file found in this project');
    });
  });

  describe('[r1.9] a malformed `render` key', () => {
    it.each([
      [{ enabled: 'false' }, 'render.enabled must be a boolean'],
      [{ path: 5 }, 'render.path must be a string'],
      [{ names: ['A', 1] }, 'render.names must be an array of strings'],
    ])('render %j fails `enigma render` with a config error naming .enigma.json and the key, and renders nothing', async (render, message) => {
      await set('A', 'value-a');
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render }));

      await expect(cmdRender([])).rejects.toMatchObject({ code: 'E_CONFIG_CORRUPT', message: expect.stringContaining(`.enigma.json: ${message}`) });
      expect(existsSync(target())).toBe(false);
      expect(readLedger().targets).toEqual([]);
    });

    it('the dispatcher prints it to stderr and exits 1', async () => {
      await set('A', 'value-a');
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { enabled: 'false' } }));

      expect(await main(['render'])).toBe(1);
      expect(stderrText()).toContain('E_CONFIG_CORRUPT: .enigma.json: render.enabled must be a boolean');
      expect(existsSync(target())).toBe(false);
    });

    it('other commands keep working with the same malformed key', async () => {
      await set('A', 'value-a');
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { enabled: 'false' } }));

      expect(listSecrets({ scope: 'project', cwd: tmpProject }).map((s) => s.name)).toEqual(['A']);
      await set('B', 'value-b');
      expect(await main(['list'])).toBe(0);
    });
  });

  describe('[r1.10] empty render set', () => {
    it('does not create the file and says there is nothing to render', async () => {
      writeFileSync(join(tmpProject, '.gitignore'), '.env\n');
      expect(await cmdRender([])).toBe(0);
      expect(stdoutText()).toBe('Nothing to render.\n');
      expect(existsSync(target())).toBe(false);
    });
  });

  describe('[r1.11] output labels', () => {
    it('a failed name with a previous line is listed under Failed only, not Kept', async () => {
      await set('KEY', 'value');
      writeFileSync(target(), '# enigma:render:begin\nKEY=prior\n# enigma:render:end\n', { mode: 0o600 });
      resolveShouldFail = true;

      expect(await cmdRender([])).toBe(1);
      expect(stdoutText()).toContain('Failed: KEY');
      expect(stdoutText()).toContain('kept previous line');
      expect(stdoutText()).not.toContain('Kept (');
    });

    it('a name narrowed out that had been rendered appears once, under Removed', async () => {
      await set('A', 'value-a');
      await set('B', 'value-b');
      writeFileSync(target(), '# enigma:render:begin\nA=old\nB=old\n# enigma:render:end\n', { mode: 0o600 });
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { names: ['A'] } }));

      expect(await cmdRender([])).toBe(0);
      expect(stdoutText()).toContain('Removed: B');
      expect(stdoutText()).not.toContain('Skipped: B');
      expect(stdoutText().match(/\bB\b/g)).toHaveLength(1);
    });

    it('a name narrowed out that was never rendered appears once, under Skipped', async () => {
      await set('A', 'value-a');
      await set('B', 'value-b');
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { names: ['A'] } }));

      expect(await cmdRender([])).toBe(0);
      expect(stdoutText()).toContain('Skipped: B (excluded by .enigma.json render.names)');
      expect(stdoutText()).not.toContain('Removed');
    });
  });
  describe('[r2] fix batch round 2', () => {
    it('[r2.1] a parent directory swapped for a symlink out of the worktree while the value resolves: exit 1, E_WRITE_FAILED on stderr, nothing written outside', async () => {
      await set('A', SENTINEL);
      mkdirSync(join(tmpProject, 'sub'));
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { path: 'sub/.env' } }));
      const outside = join(tmpHome, 'outside');
      mkdirSync(outside);
      onResolve = () => {
        rmSync(join(tmpProject, 'sub'), { recursive: true });
        symlinkSync(outside, join(tmpProject, 'sub'));
      };

      expect(await main(['render'])).toBe(1);
      expect(stderrText()).toContain('E_WRITE_FAILED');
      expect(readdirSync(outside)).toEqual([]);
      expect(readLedger().targets).toEqual([]);
      expect(stdoutText() + stderrText()).not.toContain(SENTINEL);
    });

    it.each([
      ['a directory', 'as-dir', 'not a regular file'],
      ['an empty path', '', 'must name a file'],
      ['"."', '.', 'must name a file'],
      ['a trailing slash', 'as-dir/', 'must name a file'],
    ])('[r2.5] %s as render.path exits 1 with a clear message and resolves nothing', async (_label, path, message) => {
      await set('A', 'value-a');
      mkdirSync(join(tmpProject, 'as-dir'));
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { path } }));
      vi.mocked(resolveSecret).mockClear();

      expect(await main(['render'])).toBe(1);
      expect(stderrText()).toContain(`E_WRITE_FAILED: render.path`);
      expect(stderrText()).toContain(message);
      expect(resolveSecret).not.toHaveBeenCalled();
    });

    it('[r2.6] no gitignore warning when rendering is off', async () => {
      await set('A', 'value-a');
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { enabled: false } }));

      expect(await cmdRender([])).toBe(0);
      expect(stdoutText()).toContain('rendering is off');
      expect(stdoutText()).not.toContain('gitignored');
    });
  });
  describe('[r3] fix batch round 3', () => {
    it('[r3.2] a damaged render block exits 1 naming the file, resolves nothing and writes nothing', async () => {
      await set('A', 'value-a');
      const damaged = '# enigma:render:begin\nA=old\n# enigma:render:endNEW=1\n';
      writeFileSync(target(), damaged, { mode: 0o600 });
      vi.mocked(resolveSecret).mockClear();

      expect(await main(['render'])).toBe(1);
      expect(stderrText()).toContain(target());
      expect(stderrText()).toContain('damaged');
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(readFileSync(target(), 'utf8')).toBe(damaged);
      expect(readLedger().targets).toEqual([]);
    });

    it('[r3.4] render.enabled=false with an invalid render.path still says "rendering is off" and exits 0', async () => {
      await set('A', 'value-a');
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { enabled: false, path: '/etc/passwd' } }));

      expect(await cmdRender([])).toBe(0);
      expect(stdoutText()).toContain('rendering is off');
    });

    it('[r3.5] an explicit render of a name in the env block does not call resolveSecret', async () => {
      writeFileSync(target(), '# enigma:begin\nA=envblock-a\n# enigma:end\n', { mode: 0o600 });
      await set('A', 'fresh-a');
      vi.mocked(resolveSecret).mockClear();

      expect(await cmdRender(['A'])).toBe(0);
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(stdoutText()).toContain('already in the env block');
    });

    it('[r3.6] the reported file and the ledger use the real path behind an in-worktree symlinked parent', async () => {
      await set('A', 'value-a');
      mkdirSync(join(tmpProject, 'realdir'));
      symlinkSync(join(tmpProject, 'realdir'), join(tmpProject, 'link'));
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { path: 'link/local.env' } }));

      expect(await cmdRender(['--json'])).toBe(0);
      const real = join(tmpProject, 'realdir', 'local.env');
      expect((JSON.parse(stdoutText()) as { file: string }).file).toBe(real);
      expect(readLedger().targets.map((t) => t.file)).toEqual([real]);
    });

    it('[r3.8] render.path "./." exits 1 with the "must name a file" message', async () => {
      await set('A', 'value-a');
      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { path: './.' } }));

      expect(await main(['render'])).toBe(1);
      expect(stderrText()).toContain('must name a file');
    });
  });
  describe('[r4] fix batch round 4', () => {
    it('[r4.2] a valid render block followed by a second unterminated begin exits 1, resolves nothing and writes nothing', async () => {
      await set('A', 'value-a');
      const damaged = '# enigma:render:begin\nR=old\n# enigma:render:end\n# enigma:render:begin\nB=old\n';
      writeFileSync(target(), damaged, { mode: 0o600 });
      vi.mocked(resolveSecret).mockClear();

      expect(await main(['render'])).toBe(1);
      expect(stderrText()).toContain('damaged');
      expect(resolveSecret).not.toHaveBeenCalled();
      expect(readFileSync(target(), 'utf8')).toBe(damaged);
      expect(readLedger().targets).toEqual([]);
    });

    it('[r4.1] a render block at EOF without a newline is terminated by a re-render', async () => {
      await set('A', 'value-a');
      writeFileSync(target(), '# enigma:render:begin\nA=old\n# enigma:render:end', { mode: 0o600 });

      expect(await cmdRender([])).toBe(0);
      expect(readFileSync(target(), 'utf8')).toBe('# enigma:render:begin\nA=value-a\n# enigma:render:end\n');
    });
  });
});
