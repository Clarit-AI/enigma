import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEPOSITORY_MODULES } from '../../storage/detect.js';
import { listSecrets } from '../../storage/manager.js';
import { textResult } from '../result-text.js';

const PROMPT_PROFILE_BY_DEPOSITORY = new Map(DEPOSITORY_MODULES.map((m) => [m.id, m.promptProfile]));

export function registerListTool(server: McpServer): void {
  server.registerTool(
    'enigma_list',
    {
      title: 'List secrets',
      description: 'Lists registered secret names, scopes, and depositories. Never returns a value (ADR-001).',
      inputSchema: {
        scope: z.enum(['project', 'global', 'all']).optional(),
      },
    },
    async (args) => {
      const entries = listSecrets({ scope: args.scope ?? 'all', cwd: process.cwd() });
      if (entries.length === 0) return textResult('No secrets registered.');

      const lines = entries.map((e) => {
        const promptProfile = PROMPT_PROFILE_BY_DEPOSITORY.get(e.depository) ?? 'unknown';
        const shadowed = e.shadowed ? ' (shadowed by project scope)' : '';
        return `${e.name}  scope=${e.scope}  depository=${e.depository}  promptProfile=${promptProfile}  usage=${e.usage ?? '-'}  updatedAt=${e.updatedAt}${shadowed}`;
      });
      return textResult(lines.join('\n'));
    },
  );
}
