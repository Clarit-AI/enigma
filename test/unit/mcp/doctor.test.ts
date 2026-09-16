import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWithCapabilities } from './harness.js';
import { setSecret } from '../../../src/storage/manager.js';

describe('enigma_doctor', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let tmpProject: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
    mkdirSync(join(tmpProject, '.git'));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue(originalCwd);
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('reports the platform, an ok index, and the connected client elicitation capability — never a value', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: 'sk-sentinel-value-should-never-appear', scope: 'global', depository: 'encrypted', actor: 'cli' });
    const pair = await connectWithCapabilities({ elicitation: { url: {}, form: {} } });

    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).toContain('Platform:');
    expect(text).toContain('Index: ok (1 entries)');
    expect(text).toContain('Client elicitation support: url=true form=true');
    expect(text).not.toContain('sk-sentinel-value-should-never-appear');

    await pair.close();
  });

  it('reports url=false when the client does not advertise URL-mode elicitation', async () => {
    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    expect((result.content as Array<{ text: string }>)[0]?.text).toContain('Client elicitation support: url=false');
    await pair.close();
  });

  it('reports manifest gaps: names in .enigma.json that are not yet registered', async () => {
    writeFileSync(
      join(tmpProject, '.enigma.json'),
      JSON.stringify({ secrets: { OPENAI_API_KEY: 'used for chat completions', GITHUB_TOKEN: 'ci access' } }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(tmpProject);
    await setSecret({ name: 'OPENAI_API_KEY', value: 'v', scope: 'project', depository: 'env', cwd: tmpProject, actor: 'cli' });

    const pair = await connectWithCapabilities({});
    const result = await pair.client.callTool({ name: 'enigma_doctor', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';

    expect(text).toContain('Manifest gaps: GITHUB_TOKEN');
    expect(text).not.toContain('Manifest gaps: none');

    await pair.close();
  });
});
