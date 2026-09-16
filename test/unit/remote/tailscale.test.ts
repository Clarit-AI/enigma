import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (...cbArgs: unknown[]) => void;

class FakeChild extends EventEmitter {
  kill = vi.fn();
}

const execFileMock = vi.fn<(...args: unknown[]) => unknown>();
const spawnMock = vi.fn<(...args: unknown[]) => FakeChild>();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { startTailscaleServe } = await import('../../../src/remote/tailscale.js');

function stubStatusSuccess(dnsName: string): void {
  execFileMock.mockImplementation(((file: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
    expect(file).toBe('tailscale');
    expect(args).toEqual(['status', '--json']);
    queueMicrotask(() => cb(null, JSON.stringify({ Self: { DNSName: dnsName } }), ''));
    return new EventEmitter();
  }) as never);
}

describe('startTailscaleServe', () => {
  let child: FakeChild;

  beforeEach(() => {
    child = new FakeChild();
    execFileMock.mockReset();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the URL from "tailscale status --json"\'s Self.DNSName (trailing dot stripped) and starts serve in the foreground', async () => {
    stubStatusSuccess('my-machine.tailnet-name.ts.net.');
    vi.useFakeTimers();

    const promise = startTailscaleServe(4321);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    expect(spawnMock).toHaveBeenCalledWith('tailscale', ['serve', '--https=443', 'http://127.0.0.1:4321'], expect.objectContaining({ stdio: 'ignore' }));

    await vi.advanceTimersByTimeAsync(3_000);

    const tunnel = await promise;
    expect(tunnel.url).toBe('https://my-machine.tailnet-name.ts.net');
    expect(tunnel.binary).toBe('tailscale');
  });

  it('rejects without ever spawning serve when "tailscale status --json" fails', async () => {
    execFileMock.mockImplementation(((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      queueMicrotask(() => cb(new Error('not logged in'), '', ''));
      return new EventEmitter();
    }) as never);

    await expect(startTailscaleServe(4321)).rejects.toMatchObject({ code: 'E_REMOTE_UNAVAILABLE' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects when status has no DNSName for this node', async () => {
    execFileMock.mockImplementation(((_file: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      queueMicrotask(() => cb(null, JSON.stringify({ Self: {} }), ''));
      return new EventEmitter();
    }) as never);

    await expect(startTailscaleServe(4321)).rejects.toMatchObject({ code: 'E_REMOTE_UNAVAILABLE' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects if the serve process exits before the start grace period elapses', async () => {
    stubStatusSuccess('my-machine.tailnet-name.ts.net.');

    const promise = startTailscaleServe(4321);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.emit('exit', 1);

    await expect(promise).rejects.toMatchObject({ code: 'E_REMOTE_UNAVAILABLE' });
  });

  it('rejects if the serve process fails to start', async () => {
    stubStatusSuccess('my-machine.tailnet-name.ts.net.');

    const promise = startTailscaleServe(4321);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    await expect(promise).rejects.toMatchObject({ code: 'E_REMOTE_UNAVAILABLE' });
  });

  it('stop() kills the process and best-effort runs "serve ... off"; a subsequent exit is not unexpected', async () => {
    stubStatusSuccess('my-machine.tailnet-name.ts.net.');
    vi.useFakeTimers();

    const promise = startTailscaleServe(4321);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3_000);
    const tunnel = await promise;

    let unexpected = false;
    void tunnel.waitForUnexpectedExit().then(() => {
      unexpected = true;
    });

    execFileMock.mockClear();
    tunnel.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(execFileMock).toHaveBeenCalledWith('tailscale', ['serve', '--https=443', 'off'], expect.anything(), expect.any(Function));

    child.emit('exit', 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(unexpected).toBe(false);
  });

  it('an exit that was NOT caused by stop() resolves waitForUnexpectedExit (S2.3)', async () => {
    stubStatusSuccess('my-machine.tailnet-name.ts.net.');
    vi.useFakeTimers();

    const promise = startTailscaleServe(4321);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(3_000);
    const tunnel = await promise;

    const unexpected = new Promise<void>((resolve) => {
      void tunnel.waitForUnexpectedExit().then(resolve);
    });
    child.emit('exit', 1);

    await expect(unexpected).resolves.toBeUndefined();
  });
});
