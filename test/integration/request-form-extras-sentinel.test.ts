import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectWithCapabilities } from '../unit/mcp/harness.js';
import { auditLogPath } from '../../src/core/paths.js';
import { RequestStore } from '../../src/request/store.js';
import { stopServer } from '../../src/web/server.js';

// Issue #71 acceptance: S2.4 sentinel (see request-reveal.test.ts) submitted
// through the extensible request form in each of the four extra-input
// positions — extra-row value, extra-row name, blob value, blob key — must
// appear in no HTTP response body (there is no reveal here), no log/audit
// line, and the MCP outcome text of BOTH enigma_request (URL mode) and
// enigma_await (fallback).

const SENTINEL = 'sk-sentinel-value-should-never-appear';

interface Variant {
  label: string;
  fields: Array<[string, string]>;
  /** What the agent must be told (names only, never the sentinel). */
  outcomeIncludes: string[];
}

const VARIANTS: Variant[] = [
  {
    label: 'extra-row value',
    fields: [
      ['extra_name_1', 'EXTRA_ROW'],
      ['extra_value_1', SENTINEL],
    ],
    outcomeIncludes: ['EXTRA_ROW', '— added by user'],
  },
  {
    label: 'extra-row name',
    fields: [
      ['extra_name_1', SENTINEL],
      ['extra_value_1', 'some-value'],
    ],
    outcomeIncludes: ['1 invalid name skipped'],
  },
  {
    label: 'blob value',
    fields: [['dotenv_blob', `BLOB_ONE=${SENTINEL}`]],
    outcomeIncludes: ['BLOB_ONE', '— added by user'],
  },
  {
    label: 'blob key',
    fields: [['dotenv_blob', `${SENTINEL}=some-value`]],
    outcomeIncludes: ['1 invalid name skipped'],
  },
];

type Path = 'enigma_request (URL mode)' | 'enigma_await (fallback)';
const PATHS: Path[] = ['enigma_request (URL mode)', 'enigma_await (fallback)'];

describe('S2.4 sentinel through the extensible request form (Issue #71)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  const logged: string[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();

    logged.length = 0;
    const capture = (chunk: unknown): boolean => {
      logged.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };
    spies.push(
      vi.spyOn(console, 'log').mockImplementation((...args) => void logged.push(args.map(String).join(' '))),
      vi.spyOn(console, 'error').mockImplementation((...args) => void logged.push(args.map(String).join(' '))),
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture),
    );
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    for (const spy of spies.splice(0)) spy.mockRestore();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function formBody(variant: Variant): string {
    const params = new URLSearchParams({ OPENAI_API_KEY: 'declared-value', depository: 'encrypted', scope: 'global' });
    for (const [key, value] of variant.fields) params.append(key, value);
    return params.toString();
  }

  /** Runs the whole flow for one path and returns every surface the sentinel must be absent from. */
  async function run(path: Path, variant: Variant): Promise<{ surfaces: Record<string, string>; outcome: string }> {
    const surfaces: Record<string, string> = {};
    const post = async (url: string): Promise<void> => {
      surfaces.getForm = await (await fetch(url)).text();
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody(variant),
      });
      expect(resp.status).toBe(200);
      surfaces.postDone = await resp.text();
    };
    const args = { names: ['OPENAI_API_KEY'], reason: 'test', usage: 'interactive', scope: 'global' };

    if (path === 'enigma_request (URL mode)') {
      const pair = await connectWithCapabilities({ elicitation: { url: {} } });
      pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
        if (request.params.mode !== 'url') throw new Error('expected url mode');
        surfaces.elicitationUrl = request.params.url;
        surfaces.elicitationMessage = request.params.message;
        await post(request.params.url);
        return { action: 'accept' };
      });
      const result = await pair.client.callTool({ name: 'enigma_request', arguments: args });
      await pair.close();
      const outcome = (result.content as Array<{ text: string }>)[0]?.text ?? '';
      surfaces.outcome = outcome;
      return { surfaces, outcome };
    }

    const pair = await connectWithCapabilities({ elicitation: {} });
    const requested = await pair.client.callTool({ name: 'enigma_request', arguments: args });
    const requestedText = (requested.content as Array<{ text: string }>)[0]?.text ?? '';
    surfaces.requestText = requestedText;
    const { request_id, url } = JSON.parse(requestedText.split('\n')[0] ?? '{}') as { request_id: string; url: string };
    await post(url);
    const awaited = await pair.client.callTool({ name: 'enigma_await', arguments: { request_id } });
    await pair.close();
    const outcome = (awaited.content as Array<{ text: string }>)[0]?.text ?? '';
    surfaces.outcome = outcome;
    return { surfaces, outcome };
  }

  for (const path of PATHS) {
    for (const variant of VARIANTS) {
      it(`${path}: sentinel as ${variant.label} is absent from every response body, log/audit line, and the outcome text`, async () => {
        const { surfaces, outcome } = await run(path, variant);

        for (const [surface, text] of Object.entries(surfaces)) {
          expect(text, `sentinel leaked into ${surface}`).not.toContain(SENTINEL);
        }
        expect(logged.join('\n')).not.toContain(SENTINEL);
        const audit = existsSync(auditLogPath()) ? readFileSync(auditLogPath(), 'utf8') : '';
        expect(audit).not.toContain(SENTINEL);

        // The agent still learns what happened — names and counts only.
        expect(outcome).toContain('OPENAI_API_KEY');
        for (const expected of variant.outcomeIncludes) expect(outcome).toContain(expected);
      });
    }
  }
});
