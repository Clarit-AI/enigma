import { describe, expect, it, vi } from 'vitest';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { elicitUrl, URL_ELICITATION_ACK_TIMEOUT_MS } from '../../../src/mcp/elicit.js';

describe('elicitUrl', () => {
  const opts = { elicitationId: 'id1', url: 'http://127.0.0.1:1/r/id1', message: 'Enter X' };

  it('sends a url-mode elicitation and, by default, leaves the request timeout to the SDK (enigma_reveal and enigma_import rely on that)', async () => {
    const elicitInput = vi.fn().mockResolvedValue({ action: 'accept' });

    await elicitUrl({ elicitInput } as unknown as Server, opts);

    expect(elicitInput).toHaveBeenCalledWith({ mode: 'url', elicitationId: 'id1', url: opts.url, message: 'Enter X' }, undefined);
  });

  it('passes an explicit timeout through (enigma_request uses the acknowledgement timeout)', async () => {
    const elicitInput = vi.fn().mockResolvedValue({ action: 'accept' });

    await elicitUrl({ elicitInput } as unknown as Server, opts, { timeout: URL_ELICITATION_ACK_TIMEOUT_MS });

    expect(elicitInput).toHaveBeenCalledWith(expect.objectContaining({ mode: 'url' }), { timeout: 30_000 });
  });
});
