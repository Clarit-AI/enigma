import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { readStdinJson } from '../../../src/hooks/stdin.js';

describe('readStdinJson', () => {
  let originalStdin: NodeJS.ReadStream;

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  });

  function fakeStdin(chunks: string[]): PassThrough {
    const stream = new PassThrough();
    originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
    queueMicrotask(() => {
      for (const chunk of chunks) stream.write(chunk);
      stream.end();
    });
    return stream;
  }

  it('parses a single JSON chunk', async () => {
    fakeStdin(['{"hook_event_name":"SessionStart"}']);
    await expect(readStdinJson()).resolves.toEqual({ hook_event_name: 'SessionStart' });
  });

  it('parses JSON split across multiple chunks', async () => {
    fakeStdin(['{"a":1,', '"b":2}']);
    await expect(readStdinJson()).resolves.toEqual({ a: 1, b: 2 });
  });

  it('resolves to an empty object when stdin is empty', async () => {
    fakeStdin([]);
    await expect(readStdinJson()).resolves.toEqual({});
  });

  it('rejects on malformed JSON', async () => {
    fakeStdin(['not json']);
    await expect(readStdinJson()).rejects.toThrow();
  });

  it('rejects when the stream errors', async () => {
    const stream = new PassThrough();
    originalStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
    const promise = readStdinJson();
    queueMicrotask(() => stream.emit('error', new Error('boom')));
    await expect(promise).rejects.toThrow('boom');
  });
});
