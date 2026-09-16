// Shared test harness: a real Client + real McpServer talking over an
// in-process transport (no OS pipes) — fast and deterministic for exercising
// each tool's branches. test/integration/mcp-server.test.ts is the one place
// that drives the bundled server over a real stdio child process end to end.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../../src/mcp/server.js';

export interface ConnectedPair {
  client: Client;
  close(): Promise<void>;
}

export async function connectWithCapabilities(capabilities: ClientCapabilities): Promise<ConnectedPair> {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
