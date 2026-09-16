import type { IncomingMessage } from 'node:http';

export const MAX_BODY_BYTES = 64 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

/** Reads the whole body up to `maxBytes`; destroys the socket and rejects once the limit is crossed, so a large upload never sits fully in memory. */
export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settleError = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Stop retaining chunks (memory stays bounded) but keep draining the
        // socket rather than destroying it, so the 413 response below can
        // still be written back to the client.
        settleError(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', settleError);
  });
}

export interface ParsedSubmission {
  /** Only the names the caller told us to look for; an attacker cannot smuggle extra fields in. */
  values: Record<string, string>;
  depository?: string;
  scope?: string;
  rotate: boolean;
  confirmCreateVault: boolean;
}

function truthy(value: string | null | undefined): boolean {
  return value === 'on' || value === 'true' || value === '1';
}

/** Parses a request/reveal submission from either `application/x-www-form-urlencoded` or JSON, per docs/api-contracts.md §2. Only fields in `names` are read into `values`; nothing else in the body reaches the caller. */
export function parseSubmission(contentType: string | undefined, body: Buffer, names: readonly string[]): ParsedSubmission {
  const text = body.toString('utf8');

  if (contentType?.toLowerCase().includes('application/json')) {
    const parsed = JSON.parse(text) as {
      values?: Record<string, unknown>;
      depository?: unknown;
      scope?: unknown;
      rotate?: unknown;
      confirmCreateVault?: unknown;
    };
    const values: Record<string, string> = {};
    for (const name of names) {
      const raw = parsed.values?.[name];
      if (typeof raw === 'string') values[name] = raw;
    }
    return {
      values,
      depository: typeof parsed.depository === 'string' ? parsed.depository : undefined,
      scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
      rotate: Boolean(parsed.rotate),
      confirmCreateVault: Boolean(parsed.confirmCreateVault),
    };
  }

  const params = new URLSearchParams(text);
  const values: Record<string, string> = {};
  for (const name of names) {
    const raw = params.get(name);
    if (raw !== null) values[name] = raw;
  }
  return {
    values,
    depository: params.get('depository') ?? undefined,
    scope: params.get('scope') ?? undefined,
    rotate: truthy(params.get('rotate')),
    confirmCreateVault: truthy(params.get('confirmCreateVault')),
  };
}
