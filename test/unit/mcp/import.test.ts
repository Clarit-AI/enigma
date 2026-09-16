import { describe, expect, it } from 'vitest';
import { connectWithCapabilities } from './harness.js';

describe('enigma_import', () => {
  it('is a stub that reports not yet implemented (Issue #13)', async () => {
    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_import', arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('not yet implemented');
    await pair.close();
  });
});
