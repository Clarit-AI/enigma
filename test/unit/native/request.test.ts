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

  it('Issue #117: several names get one labelled dialog each (1 of 3, 2 of 3, 3 of 3) and each value is stored under its own name, never merged', async () => {
    const children = [new FakeChild(), new FakeChild(), new FakeChild()];
    let call = 0;
    spawnMock.mockImplementation(() => {
      const child = children[call]!;
      emitDialogResult(child, `${SENTINEL}-value-${call}`);
      call += 1;
      return child;
    });

    const result = await nativeRequest({
      names: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'],
      reason: 'R2 credentials for backups; R2_ENDPOINT is the account URL',
      scope: 'global',
      depository: 'encrypted',
    });

    expect(result.stored).toEqual(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT']);
    const scripts = children.map((c) => c.stdin.write.mock.calls[0]?.[0] as string);
    scripts.forEach((script, i) => {
      expect(script).toContain(`with title "Enigma (${i + 1} of 3)"`);
      expect(script).toContain(`(${i + 1} of 3). Enter only this one value`);
    });
    expect(scripts[0]).toContain('Enter value for R2_ACCESS_KEY_ID (1 of 3)');
    expect(scripts[1]).toContain('Enter value for R2_SECRET_ACCESS_KEY (2 of 3)');
    expect(scripts[2]).toContain('Enter value for R2_ENDPOINT (3 of 3)');
    for (const [i, name] of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'].entries()) {
      expect(await resolveSecret(name, { scope: 'global', actor: 'cli' })).toBe(`${SENTINEL}-value-${i}`);
    }
  });

  it('Issue #117: a continuation (progress offset) keeps the numbering instead of restarting at 1 of 1', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementation(() => {
      emitDialogResult(child, SENTINEL);
      return child;
    });

    await nativeRequest({ names: ['C'], reason: 'r', scope: 'global', depository: 'encrypted', progress: { offset: 2, total: 3 } });

    const script = child.stdin.write.mock.calls[0]?.[0] as string;
    expect(script).toContain('Enter value for C (3 of 3)');
    expect(script).toContain('with title "Enigma (3 of 3)"');
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
