import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = 'sk-clipboard-sentinel-should-never-appear';

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

const { clipboardReveal } = await import('../../../src/native/clipboard.js');
const { setSecret } = await import('../../../src/storage/manager.js');
const { auditLogPath } = await import('../../../src/core/paths.js');

/** The simulated OS clipboard the mocked pbcopy/pbpaste read and write. */
let clipboard: string;

/** Records every spawned FakeChild, in call order, keyed by index. */
function mockClipboardBinaries(children: FakeChild[]): void {
  spawnMock.mockImplementation((command: string) => {
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => {
      if (command === 'pbpaste') child.stdout.emit('data', Buffer.from(clipboard));
      child.emit('close', 0);
    });
    return child;
  });
}

describe('clipboardReveal', () => {
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
    clipboard = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('copies the resolved value to pbcopy on stdin (never argv) and returns a status string only', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const children: FakeChild[] = [];
    mockClipboardBinaries(children);

    const status = await clipboardReveal('OPENAI_API_KEY', { scope: 'global' });

    expect(status).toBe('Copied to clipboard; clears in 60 s');
    expect(status).not.toContain(SENTINEL);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe('pbcopy');
    expect(args).toEqual([]);
    expect(children[0]!.stdin.write).toHaveBeenCalledWith(SENTINEL, 'utf8');
  });

  it('clears the clipboard after 60s only if pbpaste still shows the revealed value', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const children: FakeChild[] = [];
    mockClipboardBinaries(children);

    await clipboardReveal('OPENAI_API_KEY', { scope: 'global' });
    clipboard = SENTINEL; // simulate the OS clipboard now holding the copied value

    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawnMock).toHaveBeenCalledTimes(3); // pbcopy, pbpaste (check), pbcopy (clear)
    expect(spawnMock.mock.calls[1]![0]).toBe('pbpaste');
    expect(spawnMock.mock.calls[2]![0]).toBe('pbcopy');
    expect(children[2]!.stdin.write).toHaveBeenCalledWith('', 'utf8');
  });

  it('leaves the clipboard alone if the user copied something else before 60s', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const children: FakeChild[] = [];
    mockClipboardBinaries(children);

    await clipboardReveal('OPENAI_API_KEY', { scope: 'global' });
    clipboard = 'something-else-the-user-copied';

    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawnMock).toHaveBeenCalledTimes(2); // pbcopy, pbpaste — no clearing pbcopy call
    expect(spawnMock.mock.calls[1]![0]).toBe('pbpaste');
  });

  it('audits the disclosure with op reveal, the actor, and the depository, and never the value', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const children: FakeChild[] = [];
    mockClipboardBinaries(children);

    await clipboardReveal('OPENAI_API_KEY', { scope: 'global', actor: 'user' });

    const auditLines = readFileSync(auditLogPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const revealLine = auditLines.find((line) => line.op === 'reveal');

    expect(revealLine).toMatchObject({
      op: 'reveal',
      name: 'OPENAI_API_KEY',
      scope: 'global',
      depository: 'encrypted',
      actor: 'user',
      ok: true,
      error: null,
    });
    expect(JSON.stringify(auditLines)).not.toContain(SENTINEL);
  });

  it('defaults actor to "user" when not given', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    const children: FakeChild[] = [];
    mockClipboardBinaries(children);

    await clipboardReveal('OPENAI_API_KEY', { scope: 'global' });

    const auditLines = readFileSync(auditLogPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const revealLine = auditLines.find((line) => line.op === 'reveal');
    expect(revealLine?.actor).toBe('user');
  });

  it('throws E_NOT_FOUND for an unknown name without touching the clipboard', async () => {
    spawnMock.mockReset();

    await expect(clipboardReveal('NEVER_SET', { scope: 'global' })).rejects.toThrow(
      expect.objectContaining({ code: 'E_NOT_FOUND' }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('throws E_UI_UNAVAILABLE off-darwin without resolving the secret or touching the clipboard', async () => {
    await setSecret({ name: 'OPENAI_API_KEY', value: SENTINEL, scope: 'global', depository: 'encrypted', actor: 'cli' });
    Object.defineProperty(process, 'platform', { value: 'linux' });

    await expect(clipboardReveal('OPENAI_API_KEY', { scope: 'global' })).rejects.toThrow(
      expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
