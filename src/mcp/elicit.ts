// Shared elicitation helpers (ADR-002, D3.2). The MCP specification
// (2025-11-25) forbids form-mode elicitation for credentials and mandates URL
// mode; every tool that asks for or discloses a secret value goes through
// elicitUrl below, never server.elicitInput({mode:'form', ...}) directly.
// enigma_remove's boolean confirmation is the one legitimate form-mode use
// (a yes/no confirmation is not a credential).
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { getSupportedElicitationModes } from '@modelcontextprotocol/sdk/client/index.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';

export function supportsUrlElicitation(server: Server): boolean {
  return getSupportedElicitationModes(server.getClientCapabilities()?.elicitation).supportsUrlMode;
}

export function supportsFormElicitation(server: Server): boolean {
  return getSupportedElicitationModes(server.getClientCapabilities()?.elicitation).supportsFormMode;
}

export interface ElicitUrlOptions {
  elicitationId: string;
  /** Must carry only the request id — never a secret NAME or value (MCP spec 2025-11-25: no credentials or PII in a URL-mode URL). */
  url: string;
  message: string;
}

/**
 * Sends a mode:"url" elicitation. Resolves as soon as the client acknowledges
 * (e.g. that it has opened the URL) — it does NOT wait for the human to
 * finish the out-of-band flow. Callers that need to know the outcome (e.g.
 * enigma_request) separately await the request store's fulfilment waiter.
 */
export async function elicitUrl(server: Server, opts: ElicitUrlOptions): Promise<ElicitResult> {
  return server.elicitInput({ mode: 'url', elicitationId: opts.elicitationId, url: opts.url, message: opts.message });
}

/**
 * MCP spec: sent once the out-of-band flow the URL pointed at has actually
 * been fulfilled — not merely once the client acknowledged the URL.
 */
export async function sendElicitationComplete(server: Server, elicitationId: string): Promise<void> {
  await server.notification({ method: 'notifications/elicitation/complete', params: { elicitationId } });
}
