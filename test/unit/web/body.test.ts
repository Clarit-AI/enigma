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

  describe('extra rows and .env blob (Issue #71)', () => {
    const form = (pairs: Array<[string, string]>): Buffer => {
      const params = new URLSearchParams();
      for (const [k, v] of pairs) params.append(k, v);
      return Buffer.from(params.toString());
    };

    it('reads extra_name_N/extra_value_N pairs in numeric row order, returning raw text', () => {
      const result = parseSubmission(
        'application/x-www-form-urlencoded',
        form([
          ['extra_name_10', 'TENTH'],
          ['extra_value_10', 'v10'],
          ['extra_name_2', 'SECOND'],
          ['extra_value_2', 'v2'],
        ]),
        names,
      );

      expect(result.extraRows).toEqual([
        { name: 'SECOND', value: 'v2' },
        { name: 'TENTH', value: 'v10' },
      ]);
    });

    it('drops a row only when BOTH fields are empty; a value without a name (or vice versa) is kept for validation', () => {
      const result = parseSubmission(
        'application/x-www-form-urlencoded',
        form([
          ['extra_name_1', ''],
          ['extra_value_1', ''],
          ['extra_name_2', ''],
          ['extra_value_2', 'orphan-value'],
          ['extra_name_3', 'NAME_ONLY'],
        ]),
        names,
      );

      expect(result.extraRows).toEqual([
        { name: '', value: 'orphan-value' },
        { name: 'NAME_ONLY', value: '' },
      ]);
    });

    it('ignores a value field with no matching name field, and any key that is not extra_name_<digits>', () => {
      const result = parseSubmission(
        'application/x-www-form-urlencoded',
        form([
          ['extra_value_1', 'lonely'],
          ['extra_name_x', 'NOT_A_ROW'],
          ['extra_name_1234567', 'TOO_MANY_DIGITS'],
          ['unrelated', 'ignored'],
        ]),
        names,
      );

      expect(result.extraRows).toEqual([]);
    });

    it('reads dotenv_blob verbatim without parsing it, and leaves it undefined when absent', () => {
      const withBlob = parseSubmission('application/x-www-form-urlencoded', form([['dotenv_blob', 'A=1\nB=2']]), names);
      const without = parseSubmission('application/x-www-form-urlencoded', form([['OPENAI_API_KEY', 'x']]), names);

      expect(withBlob.dotenvBlob).toBe('A=1\nB=2');
      expect(without.dotenvBlob).toBeUndefined();
      expect(without.extraRows).toEqual([]);
    });

    it('never lets an extra field into `values` — the declared-names allow-list is unchanged', () => {
      const result = parseSubmission(
        'application/x-www-form-urlencoded',
        form([
          ['OPENAI_API_KEY', 'declared'],
          ['extra_name_1', 'GITHUB_TOKEN'],
          ['extra_value_1', 'smuggled'],
        ]),
        ['OPENAI_API_KEY'],
      );

      expect(result.values).toEqual({ OPENAI_API_KEY: 'declared' });
    });

    it('JSON submissions carry no extras (the extensible form is form-encoded only)', () => {
      const result = parseSubmission(
        'application/json',
        Buffer.from(JSON.stringify({ values: { OPENAI_API_KEY: 'x' }, extra_name_1: 'EXTRA', extra_value_1: 'y', dotenv_blob: 'Z=1' })),
        names,
      );

      expect(result.extraRows).toEqual([]);
      expect(result.dotenvBlob).toBeUndefined();
    });
  });
});
