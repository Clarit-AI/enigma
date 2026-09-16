import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, parseSubmission, PayloadTooLargeError, readBody } from '../../../src/web/body.js';

class FakeRequest extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

function emitBody(req: FakeRequest, chunks: Buffer[]): void {
  for (const chunk of chunks) req.emit('data', chunk);
  req.emit('end');
}

describe('readBody', () => {
  it('resolves with the full body when under the limit', async () => {
    const req = new FakeRequest();
    const promise = readBody(req as unknown as Parameters<typeof readBody>[0]);
    emitBody(req, [Buffer.from('hello '), Buffer.from('world')]);

    await expect(promise).resolves.toEqual(Buffer.from('hello world'));
  });

  it('rejects with PayloadTooLargeError once the body exceeds the limit, without destroying the socket (so the 413 response can still be written)', async () => {
    const req = new FakeRequest();
    const promise = readBody(req as unknown as Parameters<typeof readBody>[0], 10);
    req.emit('data', Buffer.alloc(11, 'a'));

    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(req.destroyed).toBe(false);
  });

  it('uses the default 64KB limit when none is given', () => {
    expect(MAX_BODY_BYTES).toBe(64 * 1024);
  });
});

describe('parseSubmission', () => {
  const names = ['OPENAI_API_KEY', 'GITHUB_TOKEN'];

  it('parses application/x-www-form-urlencoded bodies, reading only the requested names', () => {
    const body = Buffer.from('OPENAI_API_KEY=sk-abc&GITHUB_TOKEN=ghp-def&EXTRA=ignored&depository=encrypted&scope=project&rotate=on');
    const result = parseSubmission('application/x-www-form-urlencoded', body, names);

    expect(result.values).toEqual({ OPENAI_API_KEY: 'sk-abc', GITHUB_TOKEN: 'ghp-def' });
    expect(result.depository).toBe('encrypted');
    expect(result.scope).toBe('project');
    expect(result.rotate).toBe(true);
    expect(result.confirmCreateVault).toBe(false);
  });

  it('parses JSON bodies matching the { values, depository, scope } contract', () => {
    const body = Buffer.from(
      JSON.stringify({ values: { OPENAI_API_KEY: 'sk-abc', EXTRA: 'ignored' }, depository: 'env', scope: 'global' }),
    );
    const result = parseSubmission('application/json', body, names);

    expect(result.values).toEqual({ OPENAI_API_KEY: 'sk-abc' });
    expect(result.depository).toBe('env');
    expect(result.scope).toBe('global');
  });

  it('omits a name from values when it was not submitted', () => {
    const body = Buffer.from('OPENAI_API_KEY=sk-abc');
    const result = parseSubmission('application/x-www-form-urlencoded', body, names);

    expect(result.values).toEqual({ OPENAI_API_KEY: 'sk-abc' });
    expect('GITHUB_TOKEN' in result.values).toBe(false);
  });
});
