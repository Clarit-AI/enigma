import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = 'sk-exec-sentinel-should-never-appear';

class FakeStream extends EventEmitter {}
class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill = vi.fn();
}

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { execWithStdin } = await import('../../../src/native/exec.js');

describe('execWithStdin', () => {
  let child: FakeChild;

  beforeEach(() => {
    child = new FakeChild();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => child);
  });

  it('spawns an argv array and feeds input on stdin, never via argv', async () => {
    const promise = execWithStdin('osascript', ['-'], SENTINEL, { timeoutMs: 1000, maxBufferBytes: 1024 });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('ok\n'));
      child.emit('close', 0);
    });

    const result = await promise;
    expect(result).toEqual({ code: 0, stdout: 'ok\n', stderr: '' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe('osascript');
    expect(args).toEqual(['-']);
    for (const arg of args as string[]) {
      expect(arg).not.toContain(SENTINEL);
    }
    expect((options as { stdio: unknown }).stdio).toEqual(['pipe', 'pipe', 'pipe']);

    expect(child.stdin.write).toHaveBeenCalledWith(SENTINEL, 'utf8');
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
  });

  it('collects stdout and stderr across multiple chunks', async () => {
    const promise = execWithStdin('cmd', [], '', { timeoutMs: 1000, maxBufferBytes: 1024 });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('a'));
      child.stdout.emit('data', Buffer.from('b'));
      child.stderr.emit('data', Buffer.from('err'));
      child.emit('close', 1);
    });

    const result = await promise;
    expect(result).toEqual({ code: 1, stdout: 'ab', stderr: 'err' });
  });

  it('rejects with E_UI_UNAVAILABLE and kills the child when maxBufferBytes is exceeded on stdout', async () => {
    const promise = execWithStdin('cmd', [], '', { timeoutMs: 1000, maxBufferBytes: 4 });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('too much output'));
    });

    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects with E_UI_UNAVAILABLE and kills the child when maxBufferBytes is exceeded on stderr', async () => {
    const promise = execWithStdin('cmd', [], '', { timeoutMs: 1000, maxBufferBytes: 4 });
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('too much output'));
    });

    const err = await promise.catch((e: unknown) => e);
    expect(err).toEqual(expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }));
    expect(String((err as Error).message)).toBe('cmd output exceeded max buffer');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects when stdout and stderr together exceed maxBufferBytes, even though neither alone does', async () => {
    const promise = execWithStdin('cmd', [], '', { timeoutMs: 1000, maxBufferBytes: 4 });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('abc')); // 3 bytes, under the cap alone
      child.stderr.emit('data', Buffer.from('abc')); // combined 6 bytes, over the shared cap
    });

    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }));
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects with E_UI_UNAVAILABLE and kills the child when the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const promise = execWithStdin('cmd', [], '', { timeoutMs: 100, maxBufferBytes: 1024 });
      const assertion = expect(promise).rejects.toThrow(expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }));
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with E_UI_UNAVAILABLE when the child process itself errors (e.g. binary missing)', async () => {
    const promise = execWithStdin('missing-cmd', [], '', { timeoutMs: 1000, maxBufferBytes: 1024 });
    const err = Object.assign(new Error('spawn missing-cmd ENOENT'), { code: 'ENOENT' });
    queueMicrotask(() => child.emit('error', err));

    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }));
  });

  it('does not resolve twice when both a timeout and a close race', async () => {
    vi.useFakeTimers();
    try {
      const promise = execWithStdin('cmd', [], '', { timeoutMs: 50, maxBufferBytes: 1024 });
      const assertion = expect(promise).rejects.toThrow(expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }));
      await vi.advanceTimersByTimeAsync(50);
      child.emit('close', 0); // late close after the timeout already settled the promise
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
