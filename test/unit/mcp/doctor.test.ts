import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithCapabilities } from './harness.js';
import { RequestStore } from '../../../src/request/store.js';
import { setSecret } from '../../../src/storage/manager.js';

describe('enigma_doctor', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
    mkdirSync(join(tmpProject, '.git'));
    originalCwd = process.cwd();
    RequestStore.__resetForTests();
  });

  afterEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    RequestStore.__resetForTests();
  });

  it('reports the platform, an ok index, and the connected client elicitation capability — never a value', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'sk-sentinel-value-should-never-appear', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({ elicitation: { url: {}, form: {} } });

    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).toContain('Platform:');
    expect(text).toContain('Index: ok (1 entries)');
    expect(text).toContain('Client elicitation support: url=true form=true');
    expect(text).not.toContain('sk-sentinel-value-should-never-appear');

    await pair.close();
  });

  it('reports url=false when the client does not advertise URL-mode elicitation', async () => {
    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('Client elicitation support: url=false');
    await pair.close();
  });

  it('reports manifest gaps: names in .enigma.json that are not yet registered', async () => {
    writeFileSync(
      join(tmpProject, '.enigma.json'),
      JSON.stringify({ secrets: { OPENAI_API_KEY: 'used for chat completions', GITHUB_TOKEN: 'ci access' } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(tmpProject);
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'project', depository: 'env', cwd: tmpProject, actor: 'cli' });

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).toContain('Manifest gaps: GITHUB_TOKEN');
    expect(text).not.toContain('Manifest gaps: none');

    await pair.close();
  });

  it('a same-named secret registered in an UNRELATED project must never mask a genuine gap here (Issue #13 review B2)', async () => {
    const otherProject = mkdtempSync(join(tmpdir(), 'enigma-other-project-'));
    mkdirSync(join(otherProject, '.git'));
    try {
      await setSecret({ name: 'API_KEY', value: 'unrelated-project-value', scope: 'project', depository: 'encrypted', cwd: otherProject, actor: 'cli' });

      writeFileSync(join(tmpProject, '.enigma.json'), JSON.stringify({ secrets: { API_KEY: 'this project needs its own' } }));
      vi.spyOn(process, 'cwd').mockReturnValue(tmpProject);

      const pair = await connectWithCapabilities({});
      const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

      expect(text).toContain('Manifest gaps: API_KEY');
      await pair.close();
    } finally {
      rmSync(otherProject, { recursive: true, force: true });
    }
  });

  it('reports a fulfilled request whose outcome was never consumed by enigma_await (Issue #62)', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'] });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [
      { name: 'OPENAI_API_KEY', ok: true },
      { name: 'GITHUB_TOKEN', ok: true },
    ]);

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).toContain('Pending unconfirmed requests:');
    expect(text).toContain(`${record.id} (names: OPENAI_API_KEY, GITHUB_TOKEN) — call enigma_await(${record.id})`);
    await pair.close();
  });

  it('adds no "Pending unconfirmed requests" line when there is nothing unconsumed', async () => {
    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).not.toContain('Pending unconfirmed requests');
    await pair.close();
  });

  it('does not report a request whose outcome was already consumed via enigma_await', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);

    const awaitPair = await connectWithCapabilities({});
    await awaitPair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });
    await awaitPair.close();

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).not.toContain('Pending unconfirmed requests');
    await pair.close();
  });

  it('never reports a fulfilled reveal as a pending unconfirmed request', async () => {
    const reveal = RequestStore.create({ kind: 'reveal', names: ['GITHUB_TOKEN'] });
    RequestStore.tryMarkUsed(reveal.id);
    RequestStore.fulfill(reveal.id);

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).not.toContain('Pending unconfirmed requests');
    await pair.close();
  });
});
