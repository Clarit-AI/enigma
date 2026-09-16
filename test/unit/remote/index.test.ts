import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteTunnel } from '../../../src/remote/types.js';

const detectCloudflaredMock = vi.fn<() => Promise<boolean>>();
const detectTailscaleMock = vi.fn<() => Promise<boolean>>();
vi.mock('../../../src/remote/detect.js', () => ({
  detectCloudflared: () => detectCloudflaredMock(),
  detectTailscale: () => detectTailscaleMock(),
}));

const startCloudflaredMock = vi.fn<(targetUrl: string) => Promise<RemoteTunnel>>();
vi.mock('../../../src/remote/cloudflared.js', () => ({
  startCloudflaredTunnel: (targetUrl: string) => startCloudflaredMock(targetUrl),
}));

const startTailscaleMock = vi.fn<(port: number) => Promise<RemoteTunnel>>();
vi.mock('../../../src/remote/tailscale.js', () => ({
  startTailscaleServe: (port: number) => startTailscaleMock(port),
}));

const { attemptRemoteTunnel, getActiveRemoteUrl, registerActiveTunnel, resolveRemotePreference, takeRemoteNote } = await import(
  '../../../src/remote/index.js'
);
const { RequestStore } = await import('../../../src/request/store.js');

/** A controllable fake RemoteTunnel: `finishUnexpectedExit()` simulates the process dying on its own. */
function fakeTunnel(url: string, binary: 'cloudflared' | 'tailscale'): RemoteTunnel & { finishUnexpectedExit: () => void } {
  let resolveExit!: () => void;
  const unexpectedExit = new Promise<void>((res) => {
    resolveExit = res;
  });
  return {
    url,
    binary,
    stop: vi.fn(),
    waitForUnexpectedExit: () => unexpectedExit,
    finishUnexpectedExit: () => resolveExit(),
  };
}

describe('resolveRemotePreference', () => {
  it('maps true -> required, "prefer" -> prefer, undefined/false -> none', () => {
    expect(resolveRemotePreference(true)).toBe('required');
    expect(resolveRemotePreference('prefer')).toBe('prefer');
    expect(resolveRemotePreference(false)).toBe('none');
    expect(resolveRemotePreference(undefined)).toBe('none');
  });
});

describe('attemptRemoteTunnel', () => {
  beforeEach(() => {
    detectCloudflaredMock.mockReset();
    detectTailscaleMock.mockReset();
    startCloudflaredMock.mockReset();
    startTailscaleMock.mockReset();
  });

  it('preference "none" never detects or starts anything', async () => {
    const result = await attemptRemoteTunnel('none', {}, 1234);
    expect(result).toBeUndefined();
    expect(detectCloudflaredMock).not.toHaveBeenCalled();
  });

  it('"required" + cloudflared unavailable throws E_REMOTE_UNAVAILABLE naming cloudflared, never starting it', async () => {
    detectCloudflaredMock.mockResolvedValue(false);

    await expect(attemptRemoteTunnel('required', {}, 1234)).rejects.toMatchObject({
      code: 'E_REMOTE_UNAVAILABLE',
      message: expect.stringContaining('cloudflared'),
    });
    expect(startCloudflaredMock).not.toHaveBeenCalled();
  });

  it('"prefer" + cloudflared unavailable returns a local-fallback note naming cloudflared, no tunnel', async () => {
    detectCloudflaredMock.mockResolvedValue(false);

    const result = await attemptRemoteTunnel('prefer', {}, 1234);
    expect(result?.tunnel).toBeUndefined();
    expect(result?.note).toContain('cloudflared');
    expect(result?.note).toContain('local');
  });

  it('"required" + cloudflared available starts it and returns the tunnel', async () => {
    detectCloudflaredMock.mockResolvedValue(true);
    const tunnel = fakeTunnel('https://x.trycloudflare.com', 'cloudflared');
    startCloudflaredMock.mockResolvedValue(tunnel);

    const result = await attemptRemoteTunnel('required', {}, 4321);
    expect(result?.tunnel).toBe(tunnel);
    expect(startCloudflaredMock).toHaveBeenCalledWith('http://127.0.0.1:4321');
  });

  it('"required" + start failure rethrows (no silent local downgrade)', async () => {
    detectCloudflaredMock.mockResolvedValue(true);
    startCloudflaredMock.mockRejectedValue(new Error('cloudflared: exited before establishing a tunnel'));

    await expect(attemptRemoteTunnel('required', {}, 4321)).rejects.toMatchObject({ code: 'E_REMOTE_UNAVAILABLE' });
  });

  it('"prefer" + start failure returns a local-fallback note instead of throwing', async () => {
    detectCloudflaredMock.mockResolvedValue(true);
    startCloudflaredMock.mockRejectedValue(new Error('boom'));

    const result = await attemptRemoteTunnel('prefer', {}, 4321);
    expect(result?.tunnel).toBeUndefined();
    expect(result?.note).toContain('local');
  });

  it('config.remote:"tailscale" selects the tailscale detector/starter, not cloudflared', async () => {
    detectTailscaleMock.mockResolvedValue(true);
    const tunnel = fakeTunnel('https://host.tailnet.ts.net', 'tailscale');
    startTailscaleMock.mockResolvedValue(tunnel);

    const result = await attemptRemoteTunnel('required', { remote: 'tailscale' }, 4321);
    expect(result?.tunnel).toBe(tunnel);
    expect(startTailscaleMock).toHaveBeenCalledWith(4321);
    expect(detectCloudflaredMock).not.toHaveBeenCalled();
  });
});

describe('registerActiveTunnel / getActiveRemoteUrl / takeRemoteNote', () => {
  beforeEach(() => {
    RequestStore.__resetForTests();
  });

  afterEach(() => {
    RequestStore.__resetForTests();
  });

  it('exposes the active tunnel URL, stops it on fulfilment, and reports a "was used" note', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const tunnel = fakeTunnel('https://x.trycloudflare.com', 'cloudflared');

    registerActiveTunnel(record.id, { tunnel });
    expect(getActiveRemoteUrl(record.id)).toBe('https://x.trycloudflare.com');

    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);
    await RequestStore.waitForFulfilled(record.id);
    await Promise.resolve();
    await Promise.resolve();

    expect(tunnel.stop).toHaveBeenCalled();
    expect(takeRemoteNote(record.id)).toBe('Remote access via cloudflared was used for this request.');
    expect(takeRemoteNote(record.id)).toBeUndefined();
  });

  it('a note-only (no-tunnel) attempt exposes no URL but does expose the fallback note', () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    registerActiveTunnel(record.id, { note: 'Remote access unavailable — cloudflared not found. Used the local link instead.' });

    expect(getActiveRemoteUrl(record.id)).toBeUndefined();
    expect(takeRemoteNote(record.id)).toContain('Used the local link instead');
  });

  it('an unexpected tunnel exit updates the note to the "lost" wording, naming the mechanism only', async () => {
    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const tunnel = fakeTunnel('https://x.trycloudflare.com', 'cloudflared');
    registerActiveTunnel(record.id, { tunnel });

    tunnel.finishUnexpectedExit();
    await Promise.resolve();
    await Promise.resolve();

    RequestStore.fulfill(record.id, [{ name: 'OPENAI_API_KEY', ok: true }]);
    await RequestStore.waitForFulfilled(record.id);
    await Promise.resolve();

    const note = takeRemoteNote(record.id);
    expect(note).toContain('cloudflared');
    expect(note).toContain('lost');
    expect(note).not.toContain('https://x.trycloudflare.com');
  });
});
