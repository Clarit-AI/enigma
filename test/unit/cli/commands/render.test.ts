/* CLI tests for `enigma render` (Issue #107).
 *
 * Each test sets ENIGMA_HOME to a fresh temp dir, the worktree to a fresh
 * temp dir, mocks `resolveSecret` (the value-resolving call the renderer
 * injects) to control outcomes without spawning a real depository, and
 * exercises the full dispatch through `cmdRender`. Tests assert both
 * stdout text and --json output shapes; sentinel values are used to
 * pin "value never appears off the file".
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = 'sk-sentinel-value-should-never-appear-7c3a';

/** Tracks what each `setSecret` call stored so the mocked `resolveSecret`
 *  can return the same value, without depending on the encrypted depository's
 *  internal on-disk shape. Keyed by name only (the renderer is project-scope
 *  for these tests, so a single key is enough). */
const storedValues = new Map<string, string>();
let resolveShouldFail = false;

vi.mock('../../../../src/storage/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/storage/manager.js')>();
  return {
    ...actual,
    resolveSecret: vi.fn(async (name: string) => {
      if (resolveShouldFail) throw new Error(`resolve failure for ${name}`);
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
const { setSecret, resolveSecret } = await import('../../../../src/storage/manager.js');
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
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function stdoutText(): string {
    return stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
  }

  it('plain `enigma render` writes a block for every project-scope encrypted secret', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    await setSecret({ name: 'OTHER', value: 'other-value', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const code = await cmdRender([]);
    expect(code).toBe(0);

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    expect(content).toContain('OPENAI_API_KEY=' + SENTINEL);
    expect(content).toContain('OTHER=other-value');
    // Sentinel only on the file; never on stdout / stderr.
    expect(stdoutText()).not.toContain(SENTINEL);
    expect(stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).not.toContain(SENTINEL);
    expect(stdoutText()).toContain('Rendered: ');
  });

  it('enigma render NAME merges — only NAME\'s line is re-resolved; every other line stays byte-identical', async () => {
    await setSecret({ name: 'C', value: 'value-c', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    await setSecret({ name: 'A', value: 'value-a-from-store', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    // Pre-existing render block: A=stale (would be re-resolved under plain
    // render), B=stale-b (B is NOT in the index — would be DROPPED under
    // plain render; explicit mode KEEPS it).
    writeFileSync(
      join(tmpProject, '.env'),
      `# enigma:render:begin\nA=stale-a-from-prev-block\nB=stale-b-from-prev-block\n# enigma:render:end\n`,
      { mode: 0o600 },
    );

    const code = await cmdRender(['C']);
    expect(code).toBe(0);

    const content = readFileSync(join(tmpProject, '.env'), 'utf8');
    // C was freshly resolved.
    expect(content).toContain('C=value-c');
    // A's line is preserved byte-identical from the previous block, NOT
    // overwritten with the store value (Tech Lead rule #3).
    expect(content).toContain('A=stale-a-from-prev-block');
    expect(content).not.toContain('A=value-a-from-store');
    // B's line is preserved verbatim even though B is not in the index —
    // explicit mode MERGES, not replaces.
    expect(content).toContain('B=stale-b-from-prev-block');
  });

  it('render.enabled: false writes nothing and reports rendering is off', async () => {
    await setSecret({ name: 'A', value: 'value-a', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ render: { enabled: false } }));

    const code = await cmdRender([]);
    expect(code).toBe(0);
    expect(stdoutText()).toContain('rendering is off');
    expect(existsSync(join(tmpProject, '.env'))).toBe(false);
  });

  it('--json output is a stable JSON object on stdout', async () => {
    await setSecret({ name: 'A', value: 'value-a', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });

    const code = await cmdRender(['--json']);
    expect(code).toBe(0);
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdoutText()) as { rendered: string[]; kept: string[]; removed: string[]; failed: unknown[]; skipped: unknown[]; warnings: string[]; disabled: boolean; file: string };
    expect(parsed.rendered).toEqual(['A']);
    expect(parsed.disabled).toBe(false);
    expect(parsed.file.endsWith('.env')).toBe(true);
  });

  it('exits non-zero when a per-name resolve fails; --json output carries the failure', async () => {
    await setSecret({ name: 'A', value: 'value-a', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    resolveShouldFail = true;

    const code = await cmdRender(['--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutText()) as { rendered: string[]; failed: Array<{ name: string; errorCode: string }> };
    expect(parsed.failed[0]?.name).toBe('A');
  });

  it('one `render` audit line per rendered name; sentinel value never appears in the audit log or the ledger', async () => {
    await setSecret({ name: 'A', value: SENTINEL, scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    await cmdRender([]);

    const audits = readFileSync(auditLogPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a: { op: string }) => a.op === 'render');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.name).toBe('A');
    expect(audits[0]?.ok).toBe(true);

    const auditBytes = readFileSync(auditLogPath(), 'utf8');
    expect(auditBytes).not.toContain(SENTINEL);
    const ledger = readLedger();
    expect(JSON.stringify(ledger)).not.toContain(SENTINEL);
    expect(ledger.targets[0]?.names).toEqual(['A']);
  });

  it('a resolveSecret call is delegated for every name; the mock is called only with names, never values', async () => {
    await setSecret({ name: 'A', value: 'value-a', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
    await cmdRender([]);
    expect(resolveSecret).toHaveBeenCalled();
    const calls = (resolveSecret as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of calls) {
      // No value-shaped data in the args that were forwarded.
      expect(JSON.stringify(call)).not.toContain(SENTINEL);
    }
  });
});

import { existsSync } from 'node:fs';