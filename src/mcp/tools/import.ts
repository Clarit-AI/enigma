import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../result-text.js';
import { DEPOSITORY_ID_SCHEMA } from '../schemas.js';

export function registerImportTool(server: McpServer): void {
  server.registerTool(
    'enigma_import',
    {
      title: 'Import secrets from a .env file',
      description: 'Imports NAME=value pairs from a .env file into a depository. Not yet implemented (Issue #13).',
      inputSchema: {
        path: z.string().optional(),
        depository: DEPOSITORY_ID_SCHEMA.optional(),
      },
    },
    async () => textResult('enigma_import: not yet implemented', true),
  );
}
