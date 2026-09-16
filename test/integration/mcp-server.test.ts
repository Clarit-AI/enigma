// Drives a real MCP client against the real, bundled enigma MCP server over
// an actual stdio child process (not an in-process transport — see
// test/unit/mcp/harness.ts for that) — the "protocol half" of S3.1: the
// product's central claim is that a secret value never rides on MCP traffic,
// and that claim is only proven by capturing every JSON-RPC message actually
// sent and received and asserting the sentinel is absent from all of them.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ClientCapabilities, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

const SENTINEL = 'sk-mcp-integration-sentinel-should-never-appear';

let bundledServerPath: string;
let bundleDir: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'enigma-mcp-bundle-'));
  bundledServerPath = join(bundleDir, 'mcp-server.mjs');
  // Mirrors scripts/build.mjs's mcp-server bundle config exactly, so this
  // test exercises the same artifact `npm run build` produces.
  await esbuild.build({
    entryPoints: ['src/mcp/server.ts'],
    outfile: bundledServerPath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    loader: { '.html': 'text' },
  });
});

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

interface CapturedMessage {
  direction: 'sent' | 'received';
  message: JSONRPCMessage;
}

/** Connects a client to the bundled server over a real stdio child process, capturing every JSON-RPC message exchanged in either direction. */
async function connect(opts: {
  tmpHome: string;
  capabilities: ClientCapabilities;
}): Promise<{ client: Client; transport: StdioClientTransport; captured: CapturedMessage[] }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundledServerPath],
    env: { ...getDefaultEnvironment(), ENIGMA_HOME: opts.tmpHome },
  });

  const captured: CapturedMessage[] = [];
  const originalSend = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage) => {
    captured.push({ direction: 'sent', message });
    return originalSend(message);
  };

  const client = new Client({ name: 'enigma-integration-test', version: '0.0.0' }, { capabilities: opts.capabilities });
  await client.connect(transport);

  const originalOnMessage = transport.onmessage;
  transport.onmessage = (message: JSONRPCMessage) => {
    captured.push({ direction: 'received', message });
    originalOnMessage?.(message);
  };

  return { client, transport, captured };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ text: string }>)[0]?.text ?? '';
}

describe('enigma MCP server, over real stdio (S3.1 protocol half)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it(
    'registers exactly the 7 tools from docs/api-contracts.md §1, and no tool schema mentions a "value"',
    async () => {
      const { client, transport } = await connect({ tmpHome, capabilities: { elicitation: { url: {} } } });
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(
          ['enigma_await', 'enigma_doctor', 'enigma_import', 'enigma_list', 'enigma_remove', 'enigma_request', 'enigma_reveal'].sort(),
        );
        for (const tool of tools) {
          const schemaText = JSON.stringify(tool);
          expect(schemaText.toLowerCase()).not.toContain('"value"');
        }
      } finally {
        await client.close();
        await transport.close();
      }
    },
  );

  it(
    'enigma_request with elicitation.url completes a full round trip (dialog -> real local server -> storage) and the sentinel never appears in any MCP message',
    async () => {
      const { client, transport, captured } = await connect({ tmpHome, capabilities: { elicitation: { url: {} } } });
      try {
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          if (request.params.mode !== 'url') throw new Error('expected url mode');
          // Simulates the human filling in the request form in a browser: the
          // sentinel travels only over this direct HTTP call to the local
          // server, never through the MCP stdio transport under test.
          const postResp = await fetch(request.params.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ OPENAI_API_KEY: SENTINEL, depository: 'encrypted', scope: 'global' }).toString(),
          });
          expect(postResp.status).toBe(200);
          return { action: 'accept' };
        });

        const result = await client.callTool({
          name: 'enigma_request',
          arguments: { names: ['OPENAI_API_KEY'], reason: 'integration test', usage: 'interactive', scope: 'global' },
        });

        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toBe('Stored OPENAI_API_KEY in encrypted (global)');

        const completeNotification = captured.find(
          (c) => c.direction === 'received' && 'method' in c.message && c.message.method === 'notifications/elicitation/complete',
        );
        expect(completeNotification).toBeDefined();

        const listResult = await client.listTools();
        expect(listResult.tools.length).toBeGreaterThan(0);

        // The full transcript of every message sent and received over this
        // connection — including the elicitation/create request and its
        // {action:"accept"} response — must never carry the sentinel.
        const transcript = JSON.stringify(captured.map((c) => c.message));
        expect(transcript).not.toContain(SENTINEL);
      } finally {
        client.setRequestHandler(ElicitRequestSchema, undefined as never);
        await client.close();
        await transport.close();
      }
    },
    15000,
  );

  it(
    'the elicitation URL itself carries only the request id — never the secret NAME or a value (MCP spec 2025-11-25)',
    async () => {
      const { client, transport } = await connect({ tmpHome, capabilities: { elicitation: { url: {} } } });
      try {
        let capturedUrl: string | undefined;
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          if (request.params.mode !== 'url') throw new Error('expected url mode');
          capturedUrl = request.params.url;
          await fetch(request.params.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ GITHUB_TOKEN: SENTINEL, depository: 'encrypted', scope: 'global' }).toString(),
          });
          return { action: 'accept' };
        });

        await client.callTool({
          name: 'enigma_request',
          arguments: { names: ['GITHUB_TOKEN'], reason: 'integration test', usage: 'interactive', scope: 'global' },
        });

        expect(capturedUrl).toBeDefined();
        expect(capturedUrl).not.toContain('GITHUB_TOKEN');
        expect(capturedUrl).not.toContain(SENTINEL);
        expect(new URL(capturedUrl!).pathname).toMatch(/^\/r\/[0-9a-f]{32}$/);
      } finally {
        client.setRequestHandler(ElicitRequestSchema, undefined as never);
        await client.close();
        await transport.close();
      }
    },
    15000,
  );

  it(
    'without elicitation.url capability, enigma_request returns a request_id and enigma_await completes the round trip once the form is submitted',
    async () => {
      const { client, transport, captured } = await connect({ tmpHome, capabilities: {} });
      try {
        const requested = await client.callTool({
          name: 'enigma_request',
          arguments: { names: ['OPENAI_API_KEY'], reason: 'integration test', usage: 'interactive', scope: 'global' },
        });
        const fallback = JSON.parse(textOf(requested).split('\n')[0] ?? '{}') as { request_id: string; url: string };
        expect(fallback.request_id).toMatch(/^[0-9a-f]{32}$/);

        const postResp = await fetch(fallback.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ OPENAI_API_KEY: SENTINEL, depository: 'encrypted', scope: 'global' }).toString(),
        });
        expect(postResp.status).toBe(200);

        const awaited = await client.callTool({ name: 'enigma_await', arguments: { request_id: fallback.request_id } });
        expect(awaited.isError).toBeFalsy();
        expect(textOf(awaited)).toBe('Stored OPENAI_API_KEY in encrypted (global)');

        const transcript = JSON.stringify(captured.map((c) => c.message));
        expect(transcript).not.toContain(SENTINEL);
      } finally {
        await client.close();
        await transport.close();
      }
    },
    15000,
  );

  it('plugins/enigma/.mcp.json launches this same bundle entrypoint', async () => {
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(readFileSync('plugins/enigma/.mcp.json', 'utf8')) as {
      mcpServers: { enigma: { command: string; args: string[] } };
    };
    expect(manifest.mcpServers.enigma.command).toBe('node');
    expect(manifest.mcpServers.enigma.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.mjs']);
  });
});
