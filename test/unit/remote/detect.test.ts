import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (...cbArgs: unknown[]) => void;

const execFileMock = vi.fn<(...args: unknown[]) => unknown>();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { detectCloudflared, detectTailscale } = await import('../../../src/remote/detect.js');

function stubExecFile(behavior: (file: string, args: string[], options: unknown, cb: ExecFileCallback) => void): void {
  execFileMock.mockImplementation(((file: string, args: string[], options: unknown, cb: ExecFileCallback) => {
    behavior(file, args, options, cb);
    return new EventEmitter();
  }) as never);
}

describe('detectCloudflared / detectTailscale', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detectCloudflared resolves true when "cloudflared --version" succeeds', async () => {
    stubExecFile((file, args, _opts, cb) => {
      expect(file).toBe('cloudflared');
      expect(args).toEqual(['--version']);
      queueMicrotask(() => cb(null, 'cloudflared version 2024.1.0', ''));
    });

    await expect(detectCloudflared()).resolves.toBe(true);
  });

  it('detectCloudflared resolves false when the binary is missing (ENOENT)', async () => {
    stubExecFile((_file, _args, _opts, cb) => {
      queueMicrotask(() => cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', ''));
    });

    await expect(detectCloudflared()).resolves.toBe(false);
  });

  it('detectTailscale resolves true when "tailscale version" succeeds', async () => {
    stubExecFile((file, args, _opts, cb) => {
      expect(file).toBe('tailscale');
      expect(args).toEqual(['version']);
      queueMicrotask(() => cb(null, '1.70.0', ''));
    });

    await expect(detectTailscale()).resolves.toBe(true);
  });

  it('detectTailscale resolves false on any execFile error, never throwing or hanging', async () => {
    stubExecFile((_file, _args, _opts, cb) => {
      queueMicrotask(() => cb(new Error('boom'), '', ''));
    });

    await expect(detectTailscale()).resolves.toBe(false);
  });

  it('passes a bounded timeout so a misbehaving binary can never hang detection', async () => {
    stubExecFile((_file, _args, opts, cb) => {
      const options = opts as { timeout?: number };
      expect(typeof options.timeout).toBe('number');
      expect(options.timeout).toBeGreaterThan(0);
      queueMicrotask(() => cb(null, '', ''));
    });

    await detectCloudflared();
  });
});
