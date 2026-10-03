/* Issue #108: `enigma import` goes through per-entry `setSecret`, so with fan-out ON an import turns the
 * unmanaged plaintext lines into a managed render block (for a no-prompt store). Real CLI and MCP paths, no
 * fan-out mock. The 7 older import test files opt OUT of fan-out; this file pins the real behavior.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdImport } from '../../../src/cli/commands/import.js';
import { auditLogPath, indexPath, renderLedgerPath } from '../../../src/core/paths.js';
import { readLedger } from '../../../src/render/ledger.js';
import { RequestStore } from '../../../src/request/store.js';
import { ENV_BEGIN_MARKER, ENV_END_MARKER, RENDER_BEGIN_MARKER, RENDER_END_MARKER } from '../../../src/storage/dotenv-file.js';
import { stopServer } from '../../../src/web/server.js';
import { connectWithCapabilities } from '../mcp/harness.js';
import type { FakeStore } from './fanout-helpers.js';
import { auditLines, installFakePromptingStore } from './fanout-helpers.js';

const OPENAI = 'sk-import-sentinel-openai-108';
const GITHUB = 'ghp-import-sentinel-github-108';
const SOURCE = `# header comment, kept\nOPENAI_API_KEY=${OPENAI}\nGITHUB_TOKEN=${GITHUB}\nlower_case_ignored=untouched\n`;

let home: string;
let project: string;
let envPath: string;
let priorHome: string | undefined;
let priorCwd: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
let fake: FakeStore | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'enigma-home-'));
  priorHome = process.env.ENIGMA_HOME;
  process.env.ENIGMA_HOME = home;
  project = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
  mkdirSync(join(project, '.git'));
  envPath = join(project, '.env');
  priorCwd = process.cwd();
  process.chdir(project);
  RequestStore.__resetForTests();
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  await stopServer();
  RequestStore.__resetForTests();
  process.chdir(priorCwd);
  fake?.restore();
  fake = undefined;
  if (priorHome === undefined) delete process.env.ENIGMA_HOME;
  else process.env.ENIGMA_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const out = (): string => [...stdout.mock.calls, ...stderr.mock.calls].map((c: unknown[]) => String(c[0])).join('');
const read = (): string => readFileSync(envPath, 'utf8');
const renderBlockOf = (content: string): string[] => {
  const lines = content.split('\n');
  const begin = lines.indexOf(RENDER_BEGIN_MARKER);
  const end = lines.indexOf(RENDER_END_MARKER);
  return begin === -1 ? [] : lines.slice(begin + 1, end);
};
const outsideRenderBlock = (content: string): string => {
  const lines = content.split('\n');
  const begin = lines.indexOf(RENDER_BEGIN_MARKER);
  const end = lines.indexOf(RENDER_END_MARKER);
  return begin === -1 ? content : [...lines.slice(0, begin), ...lines.slice(end + 1)].join('\n');
};

/** Nothing the import handled may appear on any surface other than the target file itself. */
function expectNoValueLeaks(extra: string[] = []): void {
  const readIfAny = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  const surfaces = [out(), ...extra, readIfAny(auditLogPath()), readIfAny(renderLedgerPath()), readIfAny(indexPath())];
  for (const s of surfaces) {
    expect(s).not.toContain(OPENAI);
    expect(s).not.toContain(GITHUB);
  }
}

describe('enigma import with render fan-out (CLI)', () => {
  it('encrypted: plaintext lines gone, the render block holds exactly the imported names, no value leaks', async () => {
    writeFileSync(envPath, SOURCE);

    const code = await cmdImport(['.env', '--depository', 'encrypted']);

    expect(code).toBe(0);
    const content = read();
    expect(renderBlockOf(content).sort()).toEqual([`GITHUB_TOKEN=${GITHUB}`, `OPENAI_API_KEY=${OPENAI}`]);
    const outside = outsideRenderBlock(content);
    expect(outside).not.toMatch(/^OPENAI_API_KEY=/m);
    expect(outside).not.toMatch(/^GITHUB_TOKEN=/m);
    expect(outside).toContain('# header comment, kept');
    expect(outside).toContain('lower_case_ignored=untouched');
    expect(outside).toContain('# Moved to Enigma (encrypted) by `enigma import`');
    expect(content.match(/^OPENAI_API_KEY=/gm)).toHaveLength(1);
    expect(readLedger().targets).toEqual([expect.objectContaining({ worktree: project, file: envPath, names: ['GITHUB_TOKEN', 'OPENAI_API_KEY'] })]);
    expect(auditLines().filter((l) => l.op === 'render').map((l) => [l.name, l.ok])).toEqual([
      ['OPENAI_API_KEY', true],
      ['GITHUB_TOKEN', true],
    ]);
    expectNoValueLeaks();
  });

  it('env: the names land in the env block and are NOT duplicated into a render block (#107 AC 3)', async () => {
    writeFileSync(envPath, SOURCE);

    expect(await cmdImport(['.env', '--depository', 'env'])).toBe(0);

    const content = read();
    expect(content).not.toContain(RENDER_BEGIN_MARKER);
    expect(content).toContain(ENV_BEGIN_MARKER);
    expect(content).toContain(ENV_END_MARKER);
    expect(content.match(/^OPENAI_API_KEY=/gm)).toHaveLength(1);
    expect(content.match(/^GITHUB_TOKEN=/gm)).toHaveLength(1);
    expect(readLedger().targets).toEqual([]);
    expect(auditLines().filter((l) => l.op === 'render')).toEqual([]);
  });

  it('a prompting store: nothing is auto-rendered', async () => {
    writeFileSync(envPath, SOURCE);
    fake = installFakePromptingStore();

    expect(await cmdImport(['.env', '--depository', 'keychain'])).toBe(0);

    expect(read()).not.toContain(RENDER_BEGIN_MARKER);
    expect(readLedger().targets).toEqual([]);
    expect(fake.resolveCalls).toEqual([]);
    expectNoValueLeaks();
  });

  it('a run with no render block yet and render disabled keeps the old shape: lines removed, nothing rendered', async () => {
    writeFileSync(join(project, '.enigma.json'), JSON.stringify({ secrets: {}, render: { enabled: false } }));
    writeFileSync(envPath, SOURCE);

    expect(await cmdImport(['.env', '--depository', 'encrypted'])).toBe(0);

    expect(read()).not.toContain(OPENAI);
    expect(read()).not.toContain(RENDER_BEGIN_MARKER);
    expect(readLedger().targets).toEqual([]);
  });
});

describe('enigma_import with render fan-out (MCP)', () => {
  it('encrypted: plaintext lines gone, render block holds exactly the imported names, result text carries no value', async () => {
    writeFileSync(envPath, SOURCE);
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_import', arguments: { depository: 'encrypted' } });

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    const content = read();
    expect(renderBlockOf(content).sort()).toEqual([`GITHUB_TOKEN=${GITHUB}`, `OPENAI_API_KEY=${OPENAI}`]);
    expect(outsideRenderBlock(content)).not.toMatch(/^(OPENAI_API_KEY|GITHUB_TOKEN)=/m);
    expect(readLedger().targets[0]?.names).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    expectNoValueLeaks([text]);
    await pair.close();
  });

  it('env: no duplicate into a render block', async () => {
    writeFileSync(envPath, SOURCE);
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_import', arguments: { depository: 'env' } });

    expect(result.isError).toBeFalsy();
    const content = read();
    expect(content).not.toContain(RENDER_BEGIN_MARKER);
    expect(content.match(/^OPENAI_API_KEY=/gm)).toHaveLength(1);
    expect(readLedger().targets).toEqual([]);
    await pair.close();
  });
});
