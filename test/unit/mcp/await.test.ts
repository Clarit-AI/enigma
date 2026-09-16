import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectWithCapabilities } from './harness.js';
import { setSecret } from '../../../src/storage/manager.js';
import { RequestStore } from '../../../src/request/store.js';
import { stopServer } from '../../../src/web/server.js';

describe('enigma_await', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    RequestStore.__resetForTests();
  });

  afterEach(async () => {
    await stopServer();
    RequestStore.__resetForTests();
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('an unknown request_id returns E_REQUEST_EXPIRED', async () => {
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_await', arguments: { request_id: '0'.repeat(32) } });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_REQUEST_EXPIRED');
    await pair.close();
  });

  it('an expired request_id returns E_REQUEST_EXPIRED', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'], ttlMs: -1 });
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_REQUEST_EXPIRED');
    await pair.close();
  });

  it('blocks until the record is fulfilled, then reports the same "Stored NAME in <depository> (<scope>)" shape as enigma_request', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const pair = await connectWithCapabilities({});

    const callPromise = pair.client.callTool({ name: 'enigma_await', arguments: { request_id: record.id } });

    await setSecret({ name: 'OPENAI_API_KEY', value: 'sentinel-value', scope: 'global', depository: 'encrypted', actor: 'user' });
    RequestStore.setResults(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);
    RequestStore.tryMarkUsed(record.id);

    const result = await callPromise;
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('Stored OPENAI_API_KEY in encrypted (global)');
    await pair.close();
  });
});
