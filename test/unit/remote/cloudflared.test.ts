import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  kill = vi.fn();
  unref = vi.fn();
}

const spawnMock = vi.fn<(...args: unknown[]) => FakeChild>();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { startCloudflaredTunnel } = await import('../../../src/remote/cloudflared.js');

describe('startCloudflaredTunnel', () => {
  let child: FakeChild;

  beforeEach(() => {
    child = new FakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns "cloudflared tunnel --url <target>" and resolves once the trycloudflare URL appears on stderr', async () => {
    const promise = startCloudflaredTunnel('http://127.0.0.1:4321');
    expect(spawnMock).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--url', 'http://127.0.0.1:4321'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    );

    child.stderr.emit('data', Buffer.from('Starting tunnel\nhttps://some-random-words.trycloudflare.com is live\n'));

    const tunnel = await promise;
    expect(tunnel.url).toBe('https://some-random-words.trycloudflare.com');
    expect(tunnel.binary).toBe('cloudflared');
  });

  it('finds the URL even when it is split across two stderr chunks', async () => {
    const promise = startCloudflaredTunnel('http://127.0.0.1:4321');

    child.stderr.emit('data', Buffer.from('https://split-across-chu'));
    child.stderr.emit('data', Buffer.from('nks.trycloudflare.com\n'));

    const tunnel = await promise;
    expect(tunnel.url).toBe('https://split-across-chunks.trycloudflare.com');
  });

  it('rejects with a name-only E_REMOTE_UNAVAILABLE if no URL appears within 20s, and kills the process', async () => {
    vi.useFakeTimers();
    const promise = startCloudflaredTunnel('http://127.0.0.1:4321');

    vi.advanceTimersByTime(20_000);

    await expect(promise).rejects.toMatchObject({ code: 'E_REMOTE_UNAVAILABLE' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects if the process exits before any URL is found', async () => {
    const promise = startCloudflaredTunnel('http://127.0.0.1:4321');
    child.emit('exit', 1);

    await expect(promise).rejects.toMatchObject({ code: 'E_REMOTE_UNAVAILABLE' });
  });

  it('rejects if the process fails to start', async () => {
    const promise = startCloudflaredTunnel('http://127.0.0.1:4321');
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    await expect(promise).rejects.toMatchObject({ code: 'E_REMOTE_UNAVAILABLE' });
  });

  it('stop() kills the process; a subsequent exit is not reported as unexpected', async () => {
    const promise = startCloudflaredTunnel('http://127.0.0.1:4321');
    child.stderr.emit('data', Buffer.from('https://example.trycloudflare.com\n'));
    const tunnel = await promise;

    let unexpected = false;
    void tunnel.waitForUnexpectedExit().then(() => {
      unexpected = true;
    });

    tunnel.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 0);
    await Promise.resolve();
    await Promise.resolve();

    expect(unexpected).toBe(false);
  });

  it('an exit that was NOT caused by stop() resolves waitForUnexpectedExit (S2.3: tunnel death mid-request)', async () => {
    const promise = startCloudflaredTunnel('http://127.0.0.1:4321');
    child.stderr.emit('data', Buffer.from('https://example.trycloudflare.com\n'));
    const tunnel = await promise;

    const unexpected = new Promise<void>((resolve) => {
      void tunnel.waitForUnexpectedExit().then(resolve);
    });

    child.emit('exit', 137);

    await expect(unexpected).resolves.toBeUndefined();
  });
});
