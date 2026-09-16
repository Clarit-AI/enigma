import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { promptSecretValue } from '../../../src/cli/prompt.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

/** Fake non-TTY stdin: an async-iterable that yields the given chunks, like a pipe. */
function fakeNonTtyStdin(chunks: string[]) {
  return {
    isTTY: false,
    setEncoding() {},
    resume() {},
    pause() {},
    on() {},
    removeListener() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** Fake TTY stdin: an EventEmitter with the raw-mode surface promptSecretValue needs. */
class FakeTtyStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModeCalls: boolean[] = [];
  setRawMode(mode: boolean) {
    this.isRaw = mode;
    this.rawModeCalls.push(mode);
  }
  setEncoding() {}
  resume() {}
  pause() {}
}

function fakeStderr() {
  const chunks: string[] = [];
  return { chunks, write: (s: string) => (chunks.push(s), true) };
}

describe('promptSecretValue', () => {
  it('reads one line from non-TTY stdin without a prompt', async () => {
    const stdin = fakeNonTtyStdin([`${SENTINEL}\nignored-second-line\n`]);
    const value = await promptSecretValue('Enter value: ', { stdin });
    expect(value).toBe(SENTINEL);
  });

  it('stops at the first line even split across multiple chunks', async () => {
    const stdin = fakeNonTtyStdin(['sk-sen', 'tinel\n', 'ignored\n']);
    const value = await promptSecretValue('Enter value: ', { stdin });
    expect(value).toBe('sk-sentinel');
  });

  it('returns the buffered content when stdin ends without a trailing newline', async () => {
    const stdin = fakeNonTtyStdin(['no-newline-value']);
    const value = await promptSecretValue('Enter value: ', { stdin });
    expect(value).toBe('no-newline-value');
  });

  it('reads a TTY line with echo disabled, restores raw mode, and never echoes the value', async () => {
    const stdin = new FakeTtyStdin();
    const stderr = fakeStderr();

    const promise = promptSecretValue('Enter value: ', { stdin, stderr });
    for (const ch of SENTINEL) stdin.emit('data', ch);
    stdin.emit('data', '\n');
    const value = await promise;

    expect(value).toBe(SENTINEL);
    expect(stdin.rawModeCalls).toEqual([true, false]);
    expect(stderr.chunks.join('')).not.toContain(SENTINEL);
  });

  it('honors backspace while reading a TTY line', async () => {
    const stdin = new FakeTtyStdin();
    const stderr = fakeStderr();

    const promise = promptSecretValue('Enter value: ', { stdin, stderr });
    for (const ch of 'abcx') stdin.emit('data', ch);
    stdin.emit('data', ''); // backspace removes the trailing 'x'
    stdin.emit('data', '\n');

    await expect(promise).resolves.toBe('abc');
  });

  it('restores raw mode even when the read is aborted (Ctrl+C)', async () => {
    const stdin = new FakeTtyStdin();
    const stderr = fakeStderr();

    const promise = promptSecretValue('Enter value: ', { stdin, stderr });
    stdin.emit('data', '');

    await expect(promise).rejects.toThrow('aborted');
    expect(stdin.rawModeCalls).toEqual([true, false]);
  });
});
