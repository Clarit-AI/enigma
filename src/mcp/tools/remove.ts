import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readIndex, resolveIndexEntry } from '../../core/index-store.js';
import { projectId as computeProjectId } from '../../core/project.js';
import { deleteSecret } from '../../storage/manager.js';
import { supportsFormElicitation } from '../elicit.js';
import { errorResult, textResult } from '../result-text.js';
import { SCOPE_SCHEMA } from '../schemas.js';

export function registerRemoveTool(server: McpServer): void {
  server.registerTool(
    'enigma_remove',
    {
      title: 'Remove a secret',
      description:
        'Deletes a secret after explicit confirmation. A yes/no confirmation is not a credential, so form-mode elicitation is permitted here (MCP spec 2025-11-25) — unlike enigma_request/enigma_reveal, which must use URL mode. Never returns a value (ADR-001).',
      inputSchema: {
        name: z.string(),
        scope: SCOPE_SCHEMA.optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args) => {
      const cwd = process.cwd();

      let confirmed = args.confirm ?? false;
      if (!confirmed) {
        if (!supportsFormElicitation(server.server)) {
          return textResult(
            'E_CONFIRMATION_REQUIRED: pass confirm:true to remove this secret, or ask the user to confirm and retry',
            true,
          );
        }
        const result = await server.server.elicitInput({
          mode: 'form',
          message: `Remove ${args.name}? This cannot be undone.`,
          requestedSchema: {
            type: 'object',
            properties: { confirm: { type: 'boolean', title: 'Confirm removal' } },
            required: ['confirm'],
          },
        });
        if (result.action !== 'accept') {
          return textResult(`Removal cancelled for ${args.name}`, true);
        }
        confirmed = result.content?.confirm === true;
      }

      if (!confirmed) {
        return textResult(`Removal cancelled for ${args.name}`, true);
      }

      const pid = computeProjectId(cwd);
      const before = resolveIndexEntry(readIndex(), args.name, args.scope, pid);

      try {
        await deleteSecret(args.name, { scope: args.scope, cwd, actor: 'agent' });
      } catch (err) {
        return errorResult(err);
      }

      return textResult(`Removed ${args.name} from ${before?.depository ?? 'its depository'}`);
    },
  );
}
