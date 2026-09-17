// Issue #42's fix removed the `depository === 'env'`-only guard from the
// partial-storage warning, and the fix needs proof on a depository OTHER
// than the file-based ones exercised in import-commit.test.ts — 1password is
// used here (mirroring manager.test.ts's mocking) so this runs deterministically
// without ever touching a real `op` CLI or vault.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedDotEnvEntry } from '../../../src/storage/dotenv-file.js';

interface FakeCall {
  args: string[];
  stdinData: string;
}
const opCalls: FakeCall[] = [];
let respondToOp: (call: FakeCall) => { stdout?: string; stderr?: string; fail?: boolean };

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
        callback(Object.assign(new Error('op failure'), { stderr: result.stderr ?? '' }), result.stdout ?? '', result.stderr ?? '');
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

const { commitImport } = await import('../../../src/storage/import-commit.js');
const { listSecrets } = await import('../../../src/storage/manager.js');

function entry(name: string, value: string): ParsedDotEnvEntry {
  return { name, value, ambiguous: false };
}

describe('commitImport into 1password (Issue #42: the partial-storage warning must not be env-only)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let envFilePath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
    envFilePath = join(tmpProject, '.env');
    opCalls.length = 0;
    respondToOp = (call) => {
      if (call.args[0] === 'item' && call.args[1] === 'create') {
        return { stdout: JSON.stringify({ id: `opitem-${opCalls.length}`, title: 'x', category: 'API_CREDENTIAL' }) };
      }
      return { stdout: '' };
    };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a partial failure warns which secrets are already stored in 1password by name — not silence, which is what every non-env depository got before this fix', async () => {
    writeFileSync(envFilePath, 'DB_PASSWORD=v1\nAPI_TOKEN=v2\n');
    const original = readFileSync(envFilePath, 'utf8');

    // Pre-seed API_TOKEN in the index so the real batch below hits E_EXISTS on it.
    await commitImport({
      entries: [entry('API_TOKEN', 'already-there')],
      depository: '1password',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });
    writeFileSync(envFilePath, original);

    const result = await commitImport({
      entries: [entry('DB_PASSWORD', 'v1'), entry('API_TOKEN', 'v2')],
      depository: '1password',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });

    expect(result.succeeded).toEqual(['DB_PASSWORD']);
    expect(result.failed).toEqual([{ name: 'API_TOKEN', errorCode: 'E_EXISTS', message: expect.stringContaining('already exists') }]);
    expect(result.fileRewritten).toBe(false);

    const warning = result.warnings.find((w) => w.includes('DB_PASSWORD') && w.includes('1password'));
    expect(warning).toBeDefined();
    expect(warning).toContain('already stored in 1password');
    expect(warning).toContain('rotate');
    // Never a value, never op's raw item id.
    expect(JSON.stringify(result.warnings)).not.toContain('v1');
  });

  it('a rerun with rotate resumes into 1password and completes the batch', async () => {
    writeFileSync(envFilePath, 'DB_PASSWORD=v1\nAPI_TOKEN=v2\n');
    const original = readFileSync(envFilePath, 'utf8');

    await commitImport({
      entries: [entry('API_TOKEN', 'already-there')],
      depository: '1password',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
    });
    writeFileSync(envFilePath, original);

    const result = await commitImport({
      entries: [entry('DB_PASSWORD', 'v1'), entry('API_TOKEN', 'v2')],
      depository: '1password',
      scope: 'project',
      cwd: tmpProject,
      projectPath: tmpProject,
      envFilePath,
      actor: 'cli',
      rotate: true,
    });

    expect(result.succeeded).toEqual(['DB_PASSWORD', 'API_TOKEN']);
    expect(result.failed).toEqual([]);
    expect(result.fileRewritten).toBe(true);

    const stored = listSecrets({ scope: 'all', cwd: tmpProject });
    expect(stored.map((e) => e.name).sort()).toEqual(['API_TOKEN', 'DB_PASSWORD']);
  });
});
