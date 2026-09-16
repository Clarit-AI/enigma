import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAwaitTool } from './tools/await.js';
import { registerDoctorTool } from './tools/doctor.js';
import { registerImportTool } from './tools/import.js';
import { registerListTool } from './tools/list.js';
import { registerRemoveTool } from './tools/remove.js';
import { registerRequestTool } from './tools/request.js';
import { registerRevealTool } from './tools/reveal.js';

/**
 * Builds the `enigma` MCP server and registers exactly the 7 tools from
 * docs/api-contracts.md §1. No tool schema or result type carries a value
 * (ADR-001) — every tool's result is `{content:[{type:'text',...}], isError?}`.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'enigma', version: '0.1.0' });
  registerListTool(server);
  registerRequestTool(server);
  registerAwaitTool(server);
  registerRevealTool(server);
  registerRemoveTool(server);
  registerImportTool(server);
  registerDoctorTool(server);
  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// realpathSync matters: import.meta.url is always symlink-resolved, but
// process.argv[1] is not (e.g. macOS resolves /tmp to /private/tmp — a real
// invocation path, not just a test artifact), so comparing the raw argv path
// against it silently never matches and the server never starts.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMainModule) {
  main().catch((err) => {
    console.error('enigma mcp server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
