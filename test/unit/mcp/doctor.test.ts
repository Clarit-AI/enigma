import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithCapabilities } from './harness.js';
import { RequestStore } from '../../../src/request/store.js';
import { mutateIndex, upsertIndexEntry } from '../../../src/core/index-store.js';
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
    expect(text).toContain(`${record.id} (stored: OPENAI_API_KEY, GITHUB_TOKEN) — call enigma_await(${record.id})`);
    // No failed or unknown names in this fixture; the static labels must
    // not appear at all (no names to label with them).
    expect(text).not.toMatch(/failed:/);
    expect(text).not.toMatch(/outcome unknown:/);
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

  it('labels a failed name with the static "failed:" prefix and never with errorCode or reason text (Issue #68 review)', async () => {
    const record = RequestStore.create({
      kind: 'request',
      names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'],
    });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [
      { name: 'OPENAI_API_KEY', ok: true },
      { name: 'GITHUB_TOKEN', ok: false, errorCode: 'E_VALUE_AMBIGUOUS', reason: 'flagged at parse time' },
    ]);

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).toContain('Pending unconfirmed requests:');
    // The failed label is the STATIC word "failed:" — the per-name
    // errorCode/reason text must never appear (ADR-001), and the stored
    // name must appear under "stored:" with no "failed" co-mingling.
    const line = text
      .split('\n')
      .find((l) => l.includes(record.id));
    expect(line).toBeDefined();
    expect(line!).toContain(`${record.id} (stored: OPENAI_API_KEY; failed: GITHUB_TOKEN) — call enigma_await(${record.id})`);
    expect(text).not.toContain('E_VALUE_AMBIGUOUS');
    expect(text).not.toContain('flagged at parse time');

    await pair.close();
  });

  it('labels an E_OUTCOME_UNKNOWN name with the static "outcome unknown:" prefix and never as "failed:" (Issue #40 — an unknown outcome is not a confirmed failure)', async () => {
    const record = RequestStore.create({
      kind: 'request',
      names: ['OPENAI_API_KEY', 'GITHUB_TOKEN'],
    });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [
      { name: 'OPENAI_API_KEY', ok: true },
      { name: 'GITHUB_TOKEN', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' },
    ]);

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    const line = text.split('\n').find((l) => l.includes(record.id));
    expect(line).toBeDefined();
    expect(line!).toContain(`${record.id} (stored: OPENAI_API_KEY; outcome unknown: GITHUB_TOKEN) — call enigma_await(${record.id})`);
    // Critical: the unknown name must NOT be labelled "failed:" — the
    // Issue #40 ruling says the word "failed" is never used for an
    // unknown outcome.
    expect(line!).not.toMatch(/failed:\s*GITHUB_TOKEN/);
    expect(line!).not.toMatch(/failed:.*GITHUB_TOKEN/);
    expect(text).not.toContain('E_OUTCOME_UNKNOWN');
    expect(text).not.toMatch(/failed:.*E_OUTCOME_UNKNOWN/s);

    await pair.close();
  });

  it('renders stored + failed + outcome unknown in a single record — three buckets, three static labels', async () => {
    const record = RequestStore.create({
      kind: 'request',
      names: ['A_OK', 'B_FAIL', 'C_UNKNOWN'],
    });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id, [
      { name: 'A_OK', ok: true },
      { name: 'B_FAIL', ok: false, errorCode: 'E_VALUE_AMBIGUOUS', reason: 'static-text-only' },
      { name: 'C_UNKNOWN', ok: false, errorCode: 'E_OUTCOME_UNKNOWN' },
    ]);

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    const line = text.split('\n').find((l) => l.includes(record.id));
    expect(line).toBeDefined();
    expect(line!).toContain(
      `${record.id} (stored: A_OK; failed: B_FAIL; outcome unknown: C_UNKNOWN) — call enigma_await(${record.id})`,
    );
    // ADR-001 — no per-name errorCode or reason text reaches the model.
    expect(text).not.toContain('E_VALUE_AMBIGUOUS');
    expect(text).not.toContain('E_OUTCOME_UNKNOWN');
    expect(text).not.toContain('static-text-only');

    await pair.close();
  });

  it('omits records whose `results` is empty (Issue #68 review) — nothing to re-await, nothing to render', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    RequestStore.tryMarkUsed(record.id);
    RequestStore.fulfill(record.id); // defaults to results: []

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).not.toContain('Pending unconfirmed requests');
    expect(text).not.toContain(record.id);
    expect(text).not.toContain('OPENAI_API_KEY');

    await pair.close();
  });

  describe('legacy scope entries (Issue #72)', () => {
    function seedLegacy(name: string, projectPath: string, depository: 'encrypted' | 'keychain' | 'env' = 'encrypted'): void {
      mutateIndex((cur) =>
        upsertIndexEntry(cur, {
          name,
          scope: 'project',
          projectId: 'deadbeef00000000',
          projectPath,
          depository,
          ref: `deadbeef00000000/${name}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    }

    it('reports per-class counts and the exact migrate-scope command when this repo has legacy entries', async () => {
      // projectPath exists and resolves to this repo → adoptable; dead paths → orphaned classes.
      seedLegacy('ADOPTABLE_KEY', tmpProject);
      seedLegacy('ORPHAN_KEY', '/definitely/gone/nowhere', 'keychain');
      seedLegacy('ENV_GONE', '/definitely/gone/nowhere', 'env');
      vi.spyOn(process, 'cwd').mockReturnValue(tmpProject);

      const pair = await connectWithCapabilities({});
      const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

      expect(text).toContain('Legacy scope entries:');
      expect(text).toContain('1 adoptable');
      expect(text).toContain('1 orphaned-adoptable');
      expect(text).toContain('1 orphaned-unrecoverable');
      expect(text).toContain('enigma migrate-scope');
      expect(text).toContain('--apply');

      await pair.close();
    });

    it('adds no legacy-scope line when there are no legacy entries', async () => {
      await setSecret({ name: 'CURRENT_KEY', value: 'sk-sentinel-value-should-never-appear', scope: 'global', depository: 'encrypted', actor: 'cli' });
      vi.spyOn(process, 'cwd').mockReturnValue(tmpProject);

      const pair = await connectWithCapabilities({});
      const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

      expect(text).not.toContain('Legacy scope entries');
      expect(text).not.toContain('migrate-scope');
      expect(text).not.toContain('sk-sentinel-value-should-never-appear');

      await pair.close();
    });

    it('the legacy-scope line carries names of classes and paths only — never a value', async () => {
      await setSecret({ name: 'CURRENT_KEY', value: 'sk-sentinel-value-should-never-appear', scope: 'global', depository: 'encrypted', actor: 'cli' });
      seedLegacy('ADOPTABLE_KEY', tmpProject);
      vi.spyOn(process, 'cwd').mockReturnValue(tmpProject);

      const pair = await connectWithCapabilities({});
      const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

      expect(text).toContain('Legacy scope entries:');
      expect(text).not.toContain('sk-sentinel-value-should-never-appear');

      await pair.close();
    });
  });
});
