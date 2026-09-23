import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EnigmaError } from '../../core/errors.js';
import { RequestStore } from '../../request/store.js';
import { takeRemoteNote } from '../../remote/index.js';
import { resolveRequestOutcome } from '../request-outcome.js';
import { errorResult, textResult } from '../result-text.js';

export function registerAwaitTool(server: McpServer): void {
  server.registerTool(
    'enigma_await',
    {
      title: 'Await a pending request',
      description:
        'Blocks until a request created via enigma_request (without URL-mode elicitation support) has been fulfilled by the user, or returns E_REQUEST_EXPIRED. Never returns a value (ADR-001).',
      inputSchema: {
        request_id: z.string(),
      },
    },
    async (args) => {
      const cwd = process.cwd();

      if (!RequestStore.get(args.request_id)) {
        return errorResult(
          new EnigmaError({ code: 'E_REQUEST_EXPIRED', message: `request ${args.request_id} is unknown or has expired` }),
        );
      }

      try {
        const outcome = await resolveRequestOutcome(args.request_id, cwd);
        // S2.3: this is the one channel a client without URL-mode
        // elicitation has for learning a tunnel died mid-request — by
        // mechanism name only, never the URL (docs/api-contracts.md).
        const remoteNote = takeRemoteNote(args.request_id);
        const text = remoteNote ? `${outcome.text}\n${remoteNote}` : outcome.text;
        return textResult(text, outcome.isError);
      } catch (err) {
        // resolveRequestOutcome maps used-but-swept → E_OUTCOME_UNKNOWN
        // (Issue #69 AC #5); let its EnigmaError pass through. Any other
        // rejection from waitForFulfilled is a never-used expiry and stays
        // E_REQUEST_EXPIRED — the one code the legacy call shape reserved
        // for it.
        if (err instanceof EnigmaError) return errorResult(err);
        return errorResult(
          new EnigmaError({ code: 'E_REQUEST_EXPIRED', message: `request ${args.request_id} expired before it was fulfilled` }),
        );
      }
    },
  );
}
