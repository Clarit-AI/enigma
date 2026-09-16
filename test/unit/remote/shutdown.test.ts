// Process-level tunnel cleanup (Tech Lead ruling on PR #35, round 2, item
// 1). This registration happens as a side effect of importing
// src/remote/index.ts, so every test here resets the module registry and
// installs spies on `process.once`/`process.kill` BEFORE that import runs —
// otherwise the registration would already have happened against the real
// process object before any spy existed to observe it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteTunnel } from '../../../src/remote/types.js';

type Handler = (...args: unknown[]) => void;

function fakeTunnel(url: string): RemoteTunnel {
  return {
    url,
    binary: 'cloudflared',
    stop: vi.fn(),
    waitForUnexpectedExit: () => new Promise(() => {}),
  };
}

describe('process-level tunnel shutdown', () => {
  let registered: Map<string, Handler>;
  let killMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    registered = new Map();
    const realOnce = process.once.bind(process);
    vi.spyOn(process, 'once').mockImplementation(((event: string, handler: Handler) => {
      if (event === 'exit' || event === 'SIGINT' || event === 'SIGTERM') {
        registered.set(event, handler);
        return process;
      }
      return realOnce(event, handler);
    }) as never);
    killMock = vi.fn();
    vi.spyOn(process, 'kill').mockImplementation(killMock as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers exit/SIGINT/SIGTERM handlers on import', async () => {
    await import('../../../src/remote/index.js');
    expect(registered.has('exit')).toBe(true);
    expect(registered.has('SIGINT')).toBe(true);
    expect(registered.has('SIGTERM')).toBe(true);
  });

  it('stops every active tunnel on "exit"', async () => {
    const { registerActiveTunnel } = await import('../../../src/remote/index.js');
    const { RequestStore } = await import('../../../src/request/store.js');
    RequestStore.__resetForTests();

    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const tunnel = fakeTunnel('https://x.trycloudflare.com');
    registerActiveTunnel(record.id, { tunnel });

    registered.get('exit')?.();

    expect(tunnel.stop).toHaveBeenCalled();
    RequestStore.__resetForTests();
  });

  it('SIGINT stops every active tunnel, then re-raises SIGINT so the default disposition still applies', async () => {
    const { registerActiveTunnel } = await import('../../../src/remote/index.js');
    const { RequestStore } = await import('../../../src/request/store.js');
    RequestStore.__resetForTests();

    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const tunnel = fakeTunnel('https://x.trycloudflare.com');
    registerActiveTunnel(record.id, { tunnel });

    registered.get('SIGINT')?.();

    expect(tunnel.stop).toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith(process.pid, 'SIGINT');
    RequestStore.__resetForTests();
  });

  it('SIGTERM stops every active tunnel, then re-raises SIGTERM', async () => {
    const { registerActiveTunnel } = await import('../../../src/remote/index.js');
    const { RequestStore } = await import('../../../src/request/store.js');
    RequestStore.__resetForTests();

    const record = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const tunnel = fakeTunnel('https://x.trycloudflare.com');
    registerActiveTunnel(record.id, { tunnel });

    registered.get('SIGTERM')?.();

    expect(tunnel.stop).toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    RequestStore.__resetForTests();
  });

  it('stops every tracked tunnel, not just the first, when several requests are active at once', async () => {
    const { registerActiveTunnel } = await import('../../../src/remote/index.js');
    const { RequestStore } = await import('../../../src/request/store.js');
    RequestStore.__resetForTests();

    const recordA = RequestStore.create({ kind: 'request', names: ['OPENAI_API_KEY'] });
    const recordB = RequestStore.create({ kind: 'request', names: ['GITHUB_TOKEN'] });
    const tunnelA = fakeTunnel('https://a.trycloudflare.com');
    const tunnelB = fakeTunnel('https://b.trycloudflare.com');
    registerActiveTunnel(recordA.id, { tunnel: tunnelA });
    registerActiveTunnel(recordB.id, { tunnel: tunnelB });

    registered.get('exit')?.();

    expect(tunnelA.stop).toHaveBeenCalled();
    expect(tunnelB.stop).toHaveBeenCalled();
    RequestStore.__resetForTests();
  });
});
