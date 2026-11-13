import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EnigmaError } from '../../core/errors.js';
import { RequestStore } from '../../request/store.js';
import { takeRemoteNote } from '../../remote/index.js';
import { resolveRequestOutcome } from '../request-outcome.js';
import { awaitAfterLine, errorResult, relayLinkLines, textResult } from '../result-text.js';

/**
 * Issue #142: how long `enigma_await` waits for the human to OPEN a relayed link before giving the turn back. An
 * agent that calls it straight after `enigma_request`, before the human has the link, is released after this
 * instead of blocking for the request's whole lifetime. It must stay well under the MCP SDK client's default
 * request timeout (`DEFAULT_REQUEST_TIMEOUT_MSEC`, 60 s), whose clock starts before ours: at 60 s the client gave
 * up first and the agent got `-32001 Request timed out` instead of the link (PR #144 review). A test pins the margin.
 */
export const DEFAULT_OPEN_GRACE_MS = 45_000;
let openGraceMs = DEFAULT_OPEN_GRACE_MS;
let openPollMs = 250;

/** Test-only: shrink the open-grace wait. Restore in `afterEach`. */
export function __setAwaitOpenGraceForTesting(opts: { graceMs?: number; pollMs?: number }): void {
  if (opts.graceMs !== undefined) openGraceMs = opts.graceMs;
  if (opts.pollMs !== undefined) openPollMs = opts.pollMs;
}

/**
 * True once the relayed link has been opened or the request has moved on (submitted, fulfilled or gone); false
 * if the grace period ran out with the link still unopened. A request with no relayed link (its link reached the
 * human through URL-mode elicitation) is never held back here.
 */
async function waitForOpen(id: string): Promise<boolean> {
  const deadline = Date.now() + openGraceMs;
  for (;;) {
    const record = RequestStore.get(id);
    if (!record || record.relayLink === undefined) return true;
    if (record.openedAt !== undefined || record.usedAt !== undefined || record.results !== undefined) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(openPollMs, Math.max(0, deadline - Date.now()))));
  }
}

export function registerAwaitTool(server: McpServer): void {
  server.registerTool(
    'enigma_await',
    {
      title: 'Await a pending request',
      description:
        'Blocks the turn until a request from enigma_request or enigma_import has been fulfilled by the user, or returns E_REQUEST_EXPIRED. Call it only AFTER you have sent the user the link from that result and they have said they submitted it: text you write before a running tool call may not be shown, so calling it early can leave the user without the link. If the link has not been opened within about 45 seconds, it returns without blocking further: the request is still pending, and the result repeats the link for you to send. Never returns a value (ADR-001).',
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

      // Issue #142: don't hold the turn for a link the human may never have received.
      if (!(await waitForOpen(args.request_id))) {
        const record = RequestStore.get(args.request_id);
        if (record?.relayLink !== undefined && record.openedAt === undefined && record.usedAt === undefined) {
          const pending = { request_id: record.id, state: 'pending', url: record.relayLink, expiresAt: new Date(record.expiresAt).toISOString() };
          return textResult(
            [
              JSON.stringify(pending),
              'The user has not opened the link yet, so they probably have not seen it. The request is still open.',
              ...relayLinkLines(record.relayLink, awaitAfterLine(record.kind === 'import' ? 'chosen a depository' : 'submitted the form')),
            ].join('\n'),
          );
        }
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
        // The shared mapper (resolveRequestOutcome) turns the two known
        // store rejections into structured EnigmaErrors — used-but-swept →
        // E_OUTCOME_UNKNOWN (Issue #69 AC #5), never-used/unknown →
        // E_REQUEST_EXPIRED (typed RequestExpiredError, PR #78 batch AC5).
        // Anything else is unexpected and surfaces as-is; the old blanket
        // fallback here misclassified genuine bugs as E_REQUEST_EXPIRED.
        if (err instanceof EnigmaError) return errorResult(err);
        throw err;
      }
    },
  );
}
