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

/** A name/value pair the human added to the request form (`extra_name_N` / `extra_value_N`, Issue #71). The name is raw, UNVALIDATED text: it must pass `validateName` before it goes anywhere, and is only ever counted if it does not. */
export interface ExtraRow {
  name: string;
  value: string;
}

export interface ParsedSubmission {
  /** Only the names the caller told us to look for; an attacker cannot smuggle extra fields in. */
  values: Record<string, string>;
  depository?: string;
  scope?: string;
  rotate: boolean;
  confirmCreateVault: boolean;
  /** Human-added rows, in row-number order; blank rows (both fields empty) are already dropped. Form-encoded submissions only. */
  extraRows: ExtraRow[];
  /** The pasted `.env` blob (`dotenv_blob`), if any; parsed later by `parseDotEnv`, never here. Form-encoded submissions only. */
  dotenvBlob?: string;
}

const EXTRA_NAME_FIELD = /^extra_name_(\d{1,6})$/;

/** Collects `extra_name_N`/`extra_value_N` pairs from a form-encoded body, ordered by N. */
function readExtraRows(params: URLSearchParams): ExtraRow[] {
  const indexes = new Set<number>();
  for (const key of params.keys()) {
    const match = key.match(EXTRA_NAME_FIELD);
    if (match) indexes.add(Number(match[1]));
  }
  const rows: ExtraRow[] = [];
  for (const n of [...indexes].sort((a, b) => a - b)) {
    const name = params.get(`extra_name_${n}`) ?? '';
    const value = params.get(`extra_value_${n}`) ?? '';
    if (name === '' && value === '') continue;
    rows.push({ name, value });
  }
  return rows;
}

function truthy(value: string | null | undefined): boolean {
  return value === 'on' || value === 'true' || value === '1';
}

/** Parses a request/reveal submission from either `application/x-www-form-urlencoded` or JSON, per docs/api-contracts.md §2. Only fields in `names` are read into `values`; beyond those, only the form's `extra_name_N`/`extra_value_N` rows and `dotenv_blob` (form-encoded only, Issue #71) are read — nothing else in the body reaches the caller. */
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
      extraRows: [],
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
    extraRows: readExtraRows(params),
    dotenvBlob: params.get('dotenv_blob') ?? undefined,
  };
}
