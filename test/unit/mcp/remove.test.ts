import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connectWithCapabilities } from './harness.js';
import { hasSecret, setSecret } from '../../../src/storage/manager.js';

describe('enigma_remove', () => {
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

  it('form-mode elicitation accept:true removes the secret and reports its depository', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({ elicitation: { form: {} } });
    pair.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      expect(request.params.mode).toBe('form');
      return { action: 'accept', content: { confirm: true } };
    });

    const result = await pair.client.callTool({ name: 'enigma_remove', arguments: { name: 'OPENAI_API_KEY', scope: 'global' } });

    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ text: string }>)[0]?.text).toBe('Removed OPENAI_API_KEY from encrypted');
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(false);
    await pair.close();
  });

  it('form-mode elicitation decline: cancels without deleting anything', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({ elicitation: { form: {} } });
    pair.client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));

    const result = await pair.client.callTool({ name: 'enigma_remove', arguments: { name: 'OPENAI_API_KEY', scope: 'global' } });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('cancelled');
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);
    await pair.close();
  });

  it('without form elicitation support, requires confirm:true and refuses otherwise', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({});

    const refused = await pair.client.callTool({ name: 'enigma_remove', arguments: { name: 'OPENAI_API_KEY', scope: 'global' } });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]?.text).toContain('E_CONFIRMATION_REQUIRED');
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(true);

    const confirmed = await pair.client.callTool({
      name: 'enigma_remove',
      arguments: { name: 'OPENAI_API_KEY', scope: 'global', confirm: true },
    });
    expect(confirmed.isError).toBeFalsy();
    await expect(hasSecret('OPENAI_API_KEY', { scope: 'global' })).resolves.toBe(false);

    await pair.close();
  });

  it('an ambiguous scope (both project and global hold the name) surfaces E_AMBIGUOUS_SCOPE', async () => {
    const tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
    mkdirSync(join(tmpProject, '.git'));
    try {
      await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'global', depository: 'encrypted', actor: 'cli' });
      await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'project', depository: 'encrypted', cwd: tmpProject, actor: 'cli' });
      const originalCwd = process.cwd();
      vi.spyOn(process, 'cwd').mockReturnValue(tmpProject);

      const pair = await connectWithCapabilities({});
      const result = await pair.client.callTool({
        name: 'enigma_remove',
        arguments: { name: 'OPENAI_API_KEY', confirm: true },
      });

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]?.text).toContain('E_AMBIGUOUS_SCOPE');
      await pair.close();
      vi.spyOn(process, 'cwd').mockReturnValue(originalCwd);
    } finally {
      rmSync(tmpProject, { recursive: true, force: true });
    }
  });
});
