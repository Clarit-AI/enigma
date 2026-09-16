import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectWithCapabilities } from './harness.js';
import { setSecret } from '../../../src/storage/manager.js';

const SENTINEL = 'sk-mcp-list-sentinel-should-never-appear';

describe('enigma_list', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('with no secrets registered, says so and never mentions a value', async () => {
    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_list', arguments: {} });
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('No secrets registered.');
    await pair.close();
  });

  it('lists names, scope, depository, and prompt profile — and never a value', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({});

    const result = await pair.client.callTool({ name: 'enigma_list', arguments: { scope: 'global' } });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).toContain('OPENAI_API_KEY');
    expect(text).toContain('scope=global');
    expect(text).toContain('depository=encrypted');
    expect(text).toContain('promptProfile=none');
    expect(text).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);

    await pair.close();
  });
});
