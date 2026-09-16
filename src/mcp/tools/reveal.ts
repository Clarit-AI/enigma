import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clipboardReveal } from '../../native/clipboard.js';
import { RequestStore } from '../../request/store.js';
import { startServer } from '../../web/server.js';
import { elicitUrl, sendElicitationComplete, supportsUrlElicitation } from '../elicit.js';
import { errorResult, textResult } from '../result-text.js';
import { SCOPE_SCHEMA } from '../schemas.js';

export function registerRevealTool(server: McpServer): void {
  server.registerTool(
    'enigma_reveal',
    {
      title: 'Reveal a secret to the user',
      description:
        'Opens a one-time, out-of-band disclosure of a secret value to the human via MCP URL-mode elicitation, or copies it to the clipboard on macOS. Never returns the value (ADR-001).',
      inputSchema: {
        name: z.string(),
        scope: SCOPE_SCHEMA.optional(),
        method: z.enum(['page', 'clipboard']).optional(),
      },
    },
    async (args) => {
      const cwd = process.cwd();
      const method = args.method ?? 'page';

      if (method === 'clipboard') {
        if (process.platform !== 'darwin') {
          return textResult('E_UI_UNAVAILABLE: clipboard reveal is only available on macOS', true);
        }
        try {
          return textResult(await clipboardReveal(args.name, { scope: args.scope, cwd }));
        } catch (err) {
          return errorResult(err);
        }
      }

      const handle = await startServer();
      const record = RequestStore.create({ kind: 'reveal', names: [args.name], scope: args.scope });
      const url = `${handle.origin}/v/${record.id}`;

      if (!supportsUrlElicitation(server.server)) {
        const fallback = { request_id: record.id, url, expiresAt: new Date(record.expiresAt).toISOString() };
        return textResult(`${JSON.stringify(fallback)}\nOpen this link to reveal ${args.name}.`);
      }

      const result = await elicitUrl(server.server, { elicitationId: record.id, url, message: `Reveal ${args.name}` });
      if (result.action !== 'accept') {
        return textResult(`Reveal cancelled for ${args.name}`, true);
      }

      // Non-blocking by design (Tech Lead review 2026-09-16): the revealed
      // value goes only to the human, never to the agent, so there is
      // nothing for this tool call to wait for except the user finishing
      // reading — which it must not learn. Contrast enigma_request, which
      // blocks because the agent has a real per-name outcome to learn.
      // notifications/elicitation/complete still fires, but only once the
      // human actually clicks Reveal (the request store's own fulfilment,
      // written by src/web/routes/reveal.ts's POST /v/:id/reveal handler),
      // not merely once the client acknowledges the URL — sent
      // fire-and-forget so this tool call does not block on it.
      void RequestStore.waitForFulfilled(record.id)
        .then(() => sendElicitationComplete(server.server, record.id))
        .catch(() => {
          // link expired or was never used: no completion to report
        });

      return textResult('Reveal link opened; expires in 5 min');
    },
  );
}
