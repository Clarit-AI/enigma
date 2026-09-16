import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Scope } from '../../core/index-store.js';
import { EnigmaError } from '../../core/errors.js';
import { nativeRequest } from '../../native/request.js';
import type { RequestNameResult } from '../../request/store.js';
import { RequestStore } from '../../request/store.js';
import { hasSecret } from '../../storage/manager.js';
import type { DepositoryId } from '../../storage/interfaces.js';
import { startServer } from '../../web/server.js';
import { elicitUrl, sendElicitationComplete, supportsUrlElicitation } from '../elicit.js';
import { resolveRequestOutcome } from '../request-outcome.js';
import { errorResult, renderOutcome, textResult } from '../result-text.js';
import { DEPOSITORY_ID_SCHEMA, SCOPE_SCHEMA } from '../schemas.js';

interface RequestArgs {
  names: string[];
  reason: string;
  usage: 'interactive' | 'unattended';
  depository?: DepositoryId;
  scope?: Scope;
  rotate?: boolean;
  ui?: 'web' | 'native';
  remote?: boolean;
}

/** D1.3: overwrite requires rotate; without it the tool fails fast, before ever creating a request or bothering the user. */
async function checkNotExisting(args: RequestArgs, cwd: string): Promise<EnigmaError | undefined> {
  if (args.rotate) return undefined;
  for (const name of args.names) {
    if (await hasSecret(name, { scope: args.scope ?? 'all', cwd })) {
      return new EnigmaError({
        code: 'E_EXISTS',
        message: `${name} already exists${args.scope ? ` in ${args.scope} scope` : ''}; pass rotate to overwrite`,
        secretName: name,
      });
    }
  }
  return undefined;
}

/**
 * ui:"native" bypasses the request store and the HTTP server entirely — the
 * osascript dialog IS the interaction (D2.5). `nativeRequest` stops at the
 * first cancelled/failed name and throws rather than reporting partial
 * results, so the names strictly before `err.secretName` in `args.names`
 * are the ones that were actually stored (native/request.ts: one dialog per
 * name, in order, storing each before moving to the next).
 */
async function runNative(args: RequestArgs, cwd: string): Promise<CallToolResult> {
  try {
    const result = await nativeRequest({
      names: args.names,
      reason: args.reason,
      scope: args.scope,
      depository: args.depository,
      cwd,
      usage: args.usage,
      rotate: args.rotate,
    });
    const outcome = renderOutcome(
      result.stored.map((name): RequestNameResult => ({ name, ok: true })),
      cwd,
    );
    return textResult(outcome.text, outcome.isError);
  } catch (err) {
    if (err instanceof EnigmaError && err.secretName) {
      const failIndex = args.names.indexOf(err.secretName);
      const succeeded = failIndex >= 0 ? args.names.slice(0, failIndex) : [];
      const results: RequestNameResult[] = [
        ...succeeded.map((name): RequestNameResult => ({ name, ok: true })),
        { name: err.secretName, ok: false, errorCode: err.code },
      ];
      const outcome = renderOutcome(results, cwd);
      return textResult(outcome.text, outcome.isError);
    }
    return errorResult(err);
  }
}

export function registerRequestTool(server: McpServer): void {
  server.registerTool(
    'enigma_request',
    {
      title: 'Request secrets',
      description:
        'Asks the user to enter one or more secret values out of band. Uses MCP URL-mode elicitation — the MCP specification (2025-11-25) forbids form-mode elicitation for credentials and mandates URL mode (ADR-002) — falling back to a request_id for enigma_await when the client does not advertise elicitation.url. Never returns a value (ADR-001).',
      inputSchema: {
        names: z.array(z.string()).min(1).max(10),
        reason: z.string(),
        usage: z.enum(['interactive', 'unattended']),
        depository: DEPOSITORY_ID_SCHEMA.optional(),
        scope: SCOPE_SCHEMA.optional(),
        rotate: z.boolean().optional(),
        ui: z.enum(['web', 'native']).optional(),
        remote: z.boolean().optional(),
      },
    },
    async (args) => {
      const cwd = process.cwd();

      const existsErr = await checkNotExisting(args, cwd);
      if (existsErr) return errorResult(existsErr);

      if (args.ui === 'native' && process.platform === 'darwin') {
        return runNative(args, cwd);
      }

      const handle = await startServer();
      const record = RequestStore.create({
        kind: 'request',
        names: args.names,
        reason: args.reason,
        usage: args.usage,
        depository: args.depository,
        scope: args.scope,
        rotate: args.rotate,
      });
      const url = `${handle.origin}/r/${record.id}`;

      if (!supportsUrlElicitation(server.server)) {
        const fallback = { request_id: record.id, url, expiresAt: new Date(record.expiresAt).toISOString() };
        return textResult(
          `${JSON.stringify(fallback)}\nClient does not support URL-mode elicitation. Call enigma_await with this request_id once the user has submitted the form.`,
        );
      }

      const result = await elicitUrl(server.server, {
        elicitationId: record.id,
        url,
        message: `Enter ${args.names.join(', ')} (${args.reason})`,
      });

      if (result.action !== 'accept') {
        return textResult(`Request cancelled for ${args.names.join(', ')}`, true);
      }

      const outcome = await resolveRequestOutcome(record.id, cwd);
      await sendElicitationComplete(server.server, record.id);
      return textResult(outcome.text, outcome.isError);
    },
  );
}
