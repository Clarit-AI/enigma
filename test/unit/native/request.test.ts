import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = 'sk-native-request-sentinel-should-never-appear';

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

const { nativeRequest } = await import('../../../src/native/request.js');
const { hasSecret, resolveSecret } = await import('../../../src/storage/manager.js');

function emitDialogResult(child: FakeChild, value: string): void {
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(`${value}\n`));
    child.emit('close', 0);
  });
}

function emitCancel(child: FakeChild): void {
  queueMicrotask(() => {
    child.stderr.emit('data', Buffer.from('35:36: execution error: User canceled. (-128)\n'));
    child.emit('close', 1);
  });
}

describe('nativeRequest', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalPlatform: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    spawnMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('runs osascript with the script on stdin (argv ["-"]) and stores the value via setSecret', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      emitDialogResult(child, SENTINEL);
      return child;
    });

    const result = await nativeRequest({
      names: ['OPENAI_API_KEY'],
      reason: 'testing',
      scope: 'global',
      depository: 'encrypted',
    });

    expect(result).toEqual({ stored: ['OPENAI_API_KEY'] });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe('osascript');
    expect(args).toEqual(['-']);
    for (const arg of args as string[]) {
      expect(arg).not.toContain(SENTINEL);
    }

    const scriptSentToStdin = child.stdin.write.mock.calls[0]?.[0] as string;
    expect(scriptSentToStdin).toContain('with hidden answer');
    expect(scriptSentToStdin).not.toContain(SENTINEL);

    expect(await hasSecret('OPENAI_API_KEY', { scope: 'global' })).toBe(true);
    expect(await resolveSecret('OPENAI_API_KEY', { scope: 'global', actor: 'cli' })).toBe(SENTINEL);
  });

  it('never returns the value: the result carries only names', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      emitDialogResult(child, SENTINEL);
      return child;
    });

    const result = await nativeRequest({ names: ['A_KEY'], reason: 'r', scope: 'global', depository: 'encrypted' });

    expect(Object.keys(result)).toEqual(['stored']);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('runs one dialog per name, in order, storing each', async () => {
    const children = [new FakeChild(), new FakeChild()];
    let call = 0;
    spawnMock.mockImplementation(() => {
      const child = children[call]!;
      emitDialogResult(child, `${SENTINEL}-${call}`);
      call += 1;
      return child;
    });

    const result = await nativeRequest({ names: ['A', 'B'], reason: 'r', scope: 'global', depository: 'encrypted' });

    expect(result.stored).toEqual(['A', 'B']);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(await hasSecret('A', { scope: 'global' })).toBe(true);
    expect(await hasSecret('B', { scope: 'global' })).toBe(true);
  });

  it('throws E_REQUEST_CANCELLED when the dialog is cancelled, and stores nothing', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      emitCancel(child);
      return child;
    });

    await expect(
      nativeRequest({ names: ['A_KEY'], reason: 'r', scope: 'global', depository: 'encrypted' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_REQUEST_CANCELLED' }));

    expect(await hasSecret('A_KEY', { scope: 'global' })).toBe(false);
  });

  it('stops after a cancelled dialog and never prompts for the remaining names', async () => {
    const children = [new FakeChild(), new FakeChild()];
    let call = 0;
    spawnMock.mockImplementation(() => {
      const child = children[call]!;
      emitCancel(child);
      call += 1;
      return child;
    });

    await expect(
      nativeRequest({ names: ['A', 'B'], reason: 'r', scope: 'global', depository: 'encrypted' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_REQUEST_CANCELLED' }));

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('throws E_UI_UNAVAILABLE for a non-cancel osascript failure', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('execution error: some other AppleScript failure (-1743)\n'));
        child.emit('close', 1);
      });
      return child;
    });

    await expect(
      nativeRequest({ names: ['A_KEY'], reason: 'r', scope: 'global', depository: 'encrypted' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }));
  });

  it('never places the name or reason (even hostile ones needing escaping) into argv', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      emitDialogResult(child, SENTINEL);
      return child;
    });

    await nativeRequest({
      names: ['A_KEY'],
      reason: 'quote " and backslash \\ and newline \n',
      scope: 'global',
      depository: 'encrypted',
    });

    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).toEqual(['-']);
  });

  it('returns an empty stored list without spawning anything when names is empty', async () => {
    const result = await nativeRequest({ names: [], reason: 'r', scope: 'global', depository: 'encrypted' });
    expect(result).toEqual({ stored: [] });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('throws E_UI_UNAVAILABLE off-darwin without spawning anything', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });

    await expect(nativeRequest({ names: ['A_KEY'], reason: 'r' })).rejects.toThrow(
      expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
