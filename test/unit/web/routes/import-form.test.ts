import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Mirrors request-form.test.ts: keeps `1password` availability deterministic regardless of the host machine. */
vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as EventEmitter & { write: (d: string) => boolean; end: () => void };
    stdin.write = () => true;
    stdin.end = () => {};
    const error = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
    queueMicrotask(() => callback(error, '', ''));
    const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const { startServer, stopServer } = await import('../../../../src/web/server.js');
const { RequestStore } = await import('../../../../src/request/store.js');
const { listSecrets } = await import('../../../../src/storage/manager.js');

const SENTINEL = 'sk-sentinel-value-should-never-appear';

describe('GET/POST /i/:id', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let originalCwd: string;
  let origin: string;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    originalCwd = process.cwd();
    process.chdir(tmpProject);
    RequestStore.__resetForTests();
    origin = (await startServer()).origin;
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  function envPath(): string {
    return join(tmpProject, '.env');
  }

  it('GET returns 404 for an unknown id', async () => {
    const resp = await fetch(`${origin}/i/${'a'.repeat(32)}`);
    expect(resp.status).toBe(404);
  });

  it('GET returns 404 for a request-kind id (route/kind mismatch)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const resp = await fetch(`${origin}/i/${record.id}`);
    expect(resp.status).toBe(404);
  });

  it('GET returns 410 once the id has been used', async () => {
    const record = RequestStore.create({ kind: 'import', names: ['OPENAI_API_KEY'], values: { OPENAI_API_KEY: 'x' } });
    RequestStore.tryMarkUsed(record.id);
    const resp = await fetch(`${origin}/i/${record.id}`);
    expect(resp.status).toBe(410);
  });

  it('GET renders the picker with the parsed names, no value input, and never leaks the value', async () => {
    writeFileSync(envPath(), `OPENAI_API_KEY=${SENTINEL}\n`);
    const record = RequestStore.create({
      kind: 'import',
      names: ['OPENAI_API_KEY'],
      values: { OPENAI_API_KEY: SENTINEL },
      envFilePath: envPath(),
    });

    const resp = await fetch(`${origin}/i/${record.id}`);
    const html = await resp.text();

    expect(resp.status).toBe(200);
    expect(html).toContain('OPENAI_API_KEY');
    expect(html).toContain('encrypted (no prompt)');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain(SENTINEL);
  });

  it('GET shows a gitignore warning when .env is not covered', async () => {
    writeFileSync(envPath(), 'OPENAI_API_KEY=x\n');
    const record = RequestStore.create({ kind: 'import', names: ['OPENAI_API_KEY'], values: { OPENAI_API_KEY: 'x' }, envFilePath: envPath() });

    const resp = await fetch(`${origin}/i/${record.id}`);
    expect(await resp.text()).toContain('.env is not gitignored');
  });

  it('POST without a chosen depository re-renders with an error, id stays usable', async () => {
    const record = RequestStore.create({ kind: 'import', names: ['OPENAI_API_KEY'], values: { OPENAI_API_KEY: 'x' }, envFilePath: envPath() });
    const resp = await fetch(`${origin}/i/${record.id}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });

    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('Choose a depository');
    expect(RequestStore.get(record.id)?.usedAt).toBeUndefined();
  });

  it('POST with an unavailable depository re-renders the confirmation without consuming the id', async () => {
    const record = RequestStore.create({ kind: 'import', names: ['OPENAI_API_KEY'], values: { OPENAI_API_KEY: 'x' }, envFilePath: envPath() });
    const resp = await fetch(`${origin}/i/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ depository: '1password' }).toString(),
    });

    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('1password');
    expect(html).toContain("isn't set up yet");
    expect(RequestStore.get(record.id)?.usedAt).toBeUndefined();
  });

  it('POST with a valid depository commits the import, rewrites .env, never leaks the value, and consumes the id', async () => {
    writeFileSync(envPath(), `KEEP=me\nOPENAI_API_KEY=${SENTINEL}\n`);
    const record = RequestStore.create({
      kind: 'import',
      names: ['OPENAI_API_KEY'],
      values: { OPENAI_API_KEY: SENTINEL },
      envFilePath: envPath(),
    });

    const resp = await fetch(`${origin}/i/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ depository: 'encrypted' }).toString(),
    });
    const html = await resp.text();

    expect(resp.status).toBe(200);
    expect(html).not.toContain(SENTINEL);
    expect(html).toContain('stored');
    expect(RequestStore.get(record.id)?.usedAt).toBeDefined();
    expect(RequestStore.get(record.id)?.importOutcome).toEqual({ fileRewritten: true, warnings: expect.any(Array), depository: 'encrypted' });

    const rewritten = readFileSync(envPath(), 'utf8');
    expect(rewritten).not.toContain(SENTINEL);
    expect(rewritten).toContain('KEEP=me');

    const stored = listSecrets({ scope: 'all', cwd: tmpProject });
    expect(stored.map((e) => e.name)).toEqual(['OPENAI_API_KEY']);
  });

  it('replaying a used id returns 410 and performs no second write', async () => {
    writeFileSync(envPath(), 'OPENAI_API_KEY=x\n');
    const record = RequestStore.create({ kind: 'import', names: ['OPENAI_API_KEY'], values: { OPENAI_API_KEY: 'x' }, envFilePath: envPath() });
    await fetch(`${origin}/i/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ depository: 'encrypted' }).toString(),
    });

    const replay = await fetch(`${origin}/i/${record.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ depository: 'encrypted' }).toString(),
    });
    expect(replay.status).toBe(410);
  });
});
