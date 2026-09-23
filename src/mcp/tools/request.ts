import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Scope } from '../../core/index-store.js';
import { loadConfig } from '../../core/config.js';
import { EnigmaError } from '../../core/errors.js';
import { nativeRequest } from '../../native/request.js';
import type { RequestNameResult, RequestRecord } from '../../request/store.js';
import { RequestStore } from '../../request/store.js';
import { attemptRemoteTunnel, registerActiveTunnel, resolveRemotePreference, takeRemoteNote } from '../../remote/index.js';
import type { RemoteAttempt } from '../../remote/index.js';
import { hasSecret } from '../../storage/manager.js';
import type { DepositoryId } from '../../storage/interfaces.js';
import { startServer } from '../../web/server.js';
import { elicitUrl, sendElicitationComplete, supportsFormElicitation, supportsUrlElicitation } from '../elicit.js';
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
  /** `true` → remote or an honest refusal; `"prefer"` → best-effort with a local fallback; absent → local only (Issue #12). */
  remote?: boolean | 'prefer';
  /** Explicit, one-time user confirmation to create a depository's backing collection when missing (Issue #28); consumed only by the `ui:"native"` path — the URL-mode path's actual write happens on the human's web form, which asks this itself. Never a default. */
  confirmCreateVault?: boolean;
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
 * Asks the human to confirm creating a depository's backing collection, via
 * form-mode elicitation — a yes/no confirmation is not a credential, so form
 * mode is permitted here (MCP spec 2025-11-25), the same reasoning
 * enigma_remove's `confirm` already relies on (Issue #28).
 */
async function confirmCreateVault(server: McpServer, reason: string): Promise<boolean> {
  if (!supportsFormElicitation(server.server)) return false;
  const result = await server.server.elicitInput({
    mode: 'form',
    message: `${reason} Create it now?`,
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', title: 'Create the vault' } },
      required: ['confirm'],
    },
  });
  return result.action === 'accept' && result.content?.confirm === true;
}

/**
 * ui:"native" bypasses the request store and the HTTP server entirely — the
 * osascript dialog IS the interaction (D2.5). `nativeRequest` stops at the
 * first cancelled/failed name and throws rather than reporting partial
 * results, so the names strictly before `err.secretName` in `args.names`
 * are the ones that were actually stored (native/request.ts: one dialog per
 * name, in order, storing each before moving to the next).
 *
 * An `E_VAULT_MISSING` failure is handled specially (Issue #28): unlike
 * every other failure, it doesn't end the request — it's asked about (via
 * `confirmCreateVault`, unless `args.confirmCreateVault` already answered
 * it), and on a yes the remaining names are retried with `createVault: true`.
 * Since every name in one call shares the same depository, this can only
 * ever trigger once per call — the vault either gets created or the
 * remaining names fail some other way.
 */
async function runNative(args: RequestArgs, cwd: string, server: McpServer): Promise<CallToolResult> {
  let createVault = args.confirmCreateVault ?? false;
  let pendingNames = args.names;
  const settled: RequestNameResult[] = [];

  for (;;) {
    try {
      const result = await nativeRequest({
        names: pendingNames,
        reason: args.reason,
        scope: args.scope,
        depository: args.depository,
        cwd,
        usage: args.usage,
        rotate: args.rotate,
        createVault,
      });
      settled.push(...result.stored.map((name): RequestNameResult => ({ name, ok: true })));
      const outcome = renderOutcome(settled, cwd);
      return textResult(outcome.text, outcome.isError);
    } catch (err) {
      if (!(err instanceof EnigmaError)) return errorResult(err);

      const failIndex = err.secretName ? pendingNames.indexOf(err.secretName) : -1;
      const succeededBeforeFailure = failIndex > 0 ? pendingNames.slice(0, failIndex) : [];
      settled.push(...succeededBeforeFailure.map((name): RequestNameResult => ({ name, ok: true })));

      if (err.code === 'E_VAULT_MISSING' && !createVault) {
        if (!supportsFormElicitation(server.server)) {
          return textResult(`${err.code}: ${err.message} Pass confirmCreateVault:true to enigma_request, or ask the user to confirm and retry.`, true);
        }
        const confirmed = await confirmCreateVault(server, err.message);
        if (confirmed) {
          createVault = true;
          pendingNames = failIndex >= 0 ? pendingNames.slice(failIndex) : pendingNames;
          continue;
        }
        settled.push({ name: err.secretName ?? pendingNames[0]!, ok: false, errorCode: err.code });
        const outcome = renderOutcome(settled, cwd);
        return textResult(outcome.text, outcome.isError);
      }

      if (err.secretName) {
        settled.push({ name: err.secretName, ok: false, errorCode: err.code });
        const outcome = renderOutcome(settled, cwd);
        return textResult(outcome.text, outcome.isError);
      }
      return errorResult(err);
    }
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
        remote: z.union([z.boolean(), z.literal('prefer')]).optional(),
        confirmCreateVault: z.boolean().optional(),
      },
    },
    async (args) => {
      const cwd = process.cwd();

      const existsErr = await checkNotExisting(args, cwd);
      if (existsErr) return errorResult(existsErr);

      if (args.ui === 'native' && process.platform === 'darwin') {
        return runNative(args, cwd, server);
      }

      const preference = resolveRemotePreference(args.remote);
      const clientSupportsUrl = supportsUrlElicitation(server.server);

      let remoteAttempt: RemoteAttempt | undefined;
      if (preference !== 'none' && !clientSupportsUrl) {
        // A client without URL-mode elicitation has no sanctioned
        // out-of-band channel at all: the fallback branch below returns
        // its URL as literal tool-result text, which is the model's own
        // context — exactly the channel URL-mode elicitation exists to
        // keep a public link out of (Tech Lead ruling on PR #35, round 2;
        // this Issue's leak criterion). Remote access is therefore never
        // attempted for such a client, not offered and then hidden.
        const reason =
          'this client does not support MCP URL-mode elicitation, so there is no out-of-band channel to deliver a public link through';
        if (preference === 'required') {
          return errorResult(new EnigmaError({ code: 'E_REMOTE_UNAVAILABLE', message: reason }));
        }
        remoteAttempt = { note: `Remote access unavailable — ${reason}. Used the local link instead.` };
      }

      const handle = await startServer();

      if (preference !== 'none' && clientSupportsUrl) {
        try {
          remoteAttempt = await attemptRemoteTunnel(preference, loadConfig(), handle.port);
        } catch (err) {
          // Honest refusal, not a silent localhost downgrade (PR #31's
          // finding this Issue closes): a caller asking for `remote:true`
          // that cannot be honoured gets a named E_REMOTE_UNAVAILABLE and no
          // request is ever created or elicited.
          return errorResult(err);
        }
      }

      let record: RequestRecord;
      try {
        record = RequestStore.create({
          kind: 'request',
          names: args.names,
          reason: args.reason,
          usage: args.usage,
          depository: args.depository,
          scope: args.scope,
          rotate: args.rotate,
        });
      } catch (err) {
        // Currently unreachable (zod already bounds `names` to 1–10 at the
        // schema level), but a tunnel started above must never be
        // orphaned if that assumption ever changes (QA finding on PR #35).
        remoteAttempt?.tunnel?.stop();
        throw err;
      }
      if (remoteAttempt) registerActiveTunnel(record.id, remoteAttempt);

      // `clientSupportsUrl` is false whenever `remoteAttempt.tunnel` could
      // be set (see above), so this origin is never the tunnel's when the
      // fallback branch below is the one that runs.
      const origin = remoteAttempt?.tunnel?.url ?? handle.origin;
      const url = `${origin}/r/${record.id}`;
      const remoteNote = remoteAttempt?.tunnel
        ? `Remote access via ${remoteAttempt.tunnel.binary} is active for this request.`
        : remoteAttempt?.note;

      if (!clientSupportsUrl) {
        const fallback = { request_id: record.id, url, expiresAt: new Date(record.expiresAt).toISOString() };
        const lines = [
          JSON.stringify(fallback),
          remoteNote,
          'Client does not support URL-mode elicitation. Call enigma_await with this request_id once the user has submitted the form.',
        ].filter((line): line is string => Boolean(line));
        return textResult(lines.join('\n'));
      }

      const result = await elicitUrl(server.server, {
        elicitationId: record.id,
        url,
        message: `Enter ${args.names.join(', ')} (${args.reason})`,
      });

      if (result.action !== 'accept') {
        return textResult(`Request cancelled for ${args.names.join(', ')}`, true);
      }

      try {
        const outcome = await resolveRequestOutcome(record.id, cwd);
        await sendElicitationComplete(server.server, record.id);
        const settledNote = takeRemoteNote(record.id);
        const text = settledNote ? `${outcome.text}\n${settledNote}` : outcome.text;
        return textResult(text, outcome.isError);
      } catch (err) {
        // resolveRequestOutcome already maps used-but-swept → E_OUTCOME_UNKNOWN
        // (Issue #69 AC #5); let its EnigmaError pass through. Anything else
        // is unexpected and surfaces as-is rather than silently mapping to a
        // request-specific code that doesn't fit a system error.
        if (err instanceof EnigmaError) return errorResult(err);
        throw err;
      }
    },
  );
}
