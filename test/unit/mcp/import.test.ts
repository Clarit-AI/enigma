import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitRequest } from '@modelcontextprotocol/sdk/types.js';
import { connectWithCapabilities } from './harness.js';
import { RequestStore } from '../../../src/request/store.js';
import { listSecrets } from '../../../src/storage/manager.js';
import { stopServer } from '../../../src/web/server.js';

const SENTINEL = 'sk-mcp-import-sentinel-should-never-appear';

describe('enigma_import', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let originalCwd: string;
  let envFilePath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = realpathSync(mkdtempSync(join(tmpdir(), 'enigma-project-')));
    mkdirSync(join(tmpProject, '.git'));
    envFilePath = join(tmpProject, '.env');
    originalCwd = process.cwd();
    process.chdir(tmpProject);
    RequestStore.__resetForTests();
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

  it('returns E_NOT_FOUND for a missing file', async () => {
    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_import', arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_NOT_FOUND');
    await pair.close();
  });

  it('reports "no importable secrets" for a file with nothing to import', async () => {
    writeFileSync(envFilePath, '# nothing here\n');
    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_import', arguments: {} });

    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('No importable secrets found');
    await pair.close();
  });

  it('AC6: with a depository given, returns names, counts, and depository only — never the value', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\nGITHUB_TOKEN=ghp-xyz\n`);
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_import', arguments: { depository: 'encrypted' } });

    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('GITHUB_TOKEN');
    expect(text).toContain('encrypted');
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('ghp-xyz');

    const stored = listSecrets({ scope: 'all', cwd: tmpProject });
    expect(stored.map((e) => e.name).sort()).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    await pair.close();
  });

  it('Issue #42: rotate lets a rerun after a partial failure succeed via the MCP surface too, matching the web picker', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    const pair = await connectWithCapabilities({});

    await pair.client.callTool({ name: 'enigma_import', arguments: { depository: 'encrypted' } });
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\nGITHUB_TOKEN=ghp-xyz\n`);

    const withoutRotate = await pair.client.callTool({ name: 'enigma_import', arguments: { depository: 'encrypted' } });
    expect(withoutRotate.isError).toBe(true);
    const withoutRotateText = (withoutRotate.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(withoutRotateText).toContain('E_EXISTS');

    const withRotate = await pair.client.callTool({ name: 'enigma_import', arguments: { depository: 'encrypted', rotate: true } });
    expect(withRotate.isError).toBeFalsy();
    const withRotateText = (withRotate.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(withRotateText).toContain('OPENAI_API_KEY');
    expect(withRotateText).toContain('GITHUB_TOKEN');
    expect(withRotateText).not.toContain(SENTINEL);

    const stored = listSecrets({ scope: 'all', cwd: tmpProject });
    expect(stored.map((e) => e.name).sort()).toEqual(['GITHUB_TOKEN', 'OPENAI_API_KEY']);
    await pair.close();
  });

  it('A2: refuses an ambiguous unquoted value ("PORT=3000 # dev port") through the loud-abort path, matching the CLI', async () => {
    writeFileSync(envFilePath, 'PORT=3000 # dev port\n');
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_import', arguments: { depository: 'encrypted' } });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(result.isError).toBe(true);
    expect(text).toContain('E_VALUE_AMBIGUOUS');
    expect(text).toContain('quote the value');
    expect(readFileSync(envFilePath, 'utf8')).toBe('PORT=3000 # dev port\n');
    expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
    await pair.close();
  });

  it('duplicate key: refuses through the loud-abort path, names the key, never stores or removes either line (Issue #13 review, round 4)', async () => {
    const original = 'API_KEY=real-production-key\nAPI_KEY=placeholder\n';
    writeFileSync(envFilePath, original);
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_import', arguments: { depository: 'encrypted' } });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(result.isError).toBe(true);
    expect(text).toContain('API_KEY');
    expect(text).toContain('E_VALUE_AMBIGUOUS');
    expect(text).toContain('assigned more than once');
    expect(readFileSync(envFilePath, 'utf8')).toBe(original);
    expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
    await pair.close();
  });

  it('without elicitation.url support, falls back to a request_id/url/expiresAt shape (never a value)', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_import', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).toContain('request_id');
    expect(text).toContain('enigma_await');
    expect(text).not.toContain(SENTINEL);
    await pair.close();
  });

  it('elicitation.url: sends a clean mode:"url" elicitation carrying no name/value, completes over the real HTTP round trip', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });
    let capturedUrl: string | undefined;

    pair.client.setRequestHandler(ElicitRequestSchema, async (request: { params: ElicitRequest['params'] }) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      capturedUrl = request.params.url;
      await fetch(request.params.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ depository: 'encrypted' }).toString(),
      });
      return { action: 'accept' };
    });

    const result = await pair.client.callTool({ name: 'enigma_import', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(capturedUrl).not.toContain('OPENAI_API_KEY');
    expect(capturedUrl).not.toContain(SENTINEL);
    expect(result.isError).toBeFalsy();
    expect(text).toBe('Stored OPENAI_API_KEY in encrypted (project)');
    expect(text).not.toContain(SENTINEL);

    const rewritten = readFileSync(envFilePath, 'utf8');
    expect(rewritten).not.toContain(SENTINEL);
    await pair.close();
  });

  it('elicitation.url default flow: a duplicate-key refusal surfaces the same reason as the direct --depository path, not a bare error code (Issue #13 review, round 4, finding 2)', async () => {
    const original = 'API_KEY=real-production-key\nAPI_KEY=placeholder\n';
    writeFileSync(envFilePath, original);
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });

    pair.client.setRequestHandler(ElicitRequestSchema, async (request: { params: ElicitRequest['params'] }) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      await fetch(request.params.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ depository: 'encrypted' }).toString(),
      });
      return { action: 'accept' };
    });

    const result = await pair.client.callTool({ name: 'enigma_import', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(result.isError).toBe(true);
    expect(text).toContain('API_KEY');
    expect(text).toContain('E_VALUE_AMBIGUOUS');
    expect(text).toContain('assigned more than once');
    // The reason names the key and the file, never either value.
    expect(text).not.toContain('real-production-key');
    expect(text).not.toContain('placeholder');
    expect(readFileSync(envFilePath, 'utf8')).toBe(original);
    expect(listSecrets({ scope: 'all', cwd: tmpProject })).toEqual([]);
    await pair.close();
  });

  it('URL-mode: a used-but-swept record yields E_OUTCOME_UNKNOWN via errorResult, not an unhandled rejection (PR #78 review, finding 4)', async () => {
    writeFileSync(envFilePath, `OPENAI_API_KEY=${SENTINEL}\n`);
    const pair = await connectWithCapabilities({ elicitation: { url: {} } });

    pair.client.setRequestHandler(ElicitRequestSchema, async (request: { params: ElicitRequest['params'] }) => {
      if (request.params.mode !== 'url') throw new Error('expected url mode');
      return { action: 'accept' };
    });

    // Injects the OutcomeUnknownError rejection the sweeper produces after
    // the used-record grace period, the same way await.test.ts and
    // request.test.ts do for the shared resolveRequestOutcome mapping —
    // avoids a slow/brittle multi-minute fake-timer advance while still
    // exercising the real enigma_import tool's catch around
    // resolveRequestOutcome, which (before this fix) had none.
    const { OutcomeUnknownError } = await import('../../../src/request/store.js');
    const waiterSpy = vi
      .spyOn(RequestStore, 'waitForFulfilled')
      .mockImplementationOnce(() => Promise.reject(new OutcomeUnknownError(['OPENAI_API_KEY'])));

    try {
      const result = await pair.client.callTool({ name: 'enigma_import', arguments: {} });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

      expect(result.isError).toBe(true);
      expect(text).toContain('E_OUTCOME_UNKNOWN');
      expect(text).toContain('OPENAI_API_KEY');
      expect(text).toContain('enigma list');
    } finally {
      waiterSpy.mockRestore();
    }
    await pair.close();
  });
});
