import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    queueMicrotask(() => callback(null, '', ''));
    return { stdin: { write: () => {}, end: () => {} }, kill: () => {} };
  },
}));

const existsSyncMock = vi.fn();
vi.mock('node:fs', () => ({ existsSync: (...args: unknown[]) => existsSyncMock(...args) }));

const { DEPOSITORY_MODULES, detectAll } = await import('../../src/storage/detect.js');

let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('DEPOSITORY_MODULES', () => {
  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    existsSyncMock.mockReturnValue(true);
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('registers encrypted, env, keychain, and secret-service', () => {
    expect(DEPOSITORY_MODULES.map((m) => m.id)).toEqual(['encrypted', 'env', 'keychain', 'secret-service']);
  });

  it('registers keychain and secret-service with prompt profile may-prompt', () => {
    const keychain = DEPOSITORY_MODULES.find((m) => m.id === 'keychain');
    const secretService = DEPOSITORY_MODULES.find((m) => m.id === 'secret-service');
    expect(keychain?.promptProfile).toBe('may-prompt');
    expect(secretService?.promptProfile).toBe('may-prompt');
  });

  it('registers encrypted and env with prompt profile none', () => {
    const encrypted = DEPOSITORY_MODULES.find((m) => m.id === 'encrypted');
    const env = DEPOSITORY_MODULES.find((m) => m.id === 'env');
    expect(encrypted?.promptProfile).toBe('none');
    expect(env?.promptProfile).toBe('none');
  });

  it('detectAll reports one result per registered module without prompting', async () => {
    setPlatform('darwin');
    const results = await detectAll();

    expect(results).toHaveLength(4);
    expect(results.map((r) => r.id).sort()).toEqual(['encrypted', 'env', 'keychain', 'secret-service'].sort());
  });

  it('detectAll marks keychain available and secret-service unavailable on darwin', async () => {
    setPlatform('darwin');
    const results = await detectAll();

    const keychain = results.find((r) => r.id === 'keychain');
    const secretService = results.find((r) => r.id === 'secret-service');
    expect(keychain?.available).toBe(true);
    expect(secretService?.available).toBe(false);
  });

  it('detectAll marks secret-service available and keychain unavailable on linux when the probe succeeds', async () => {
    setPlatform('linux');
    const results = await detectAll();

    const keychain = results.find((r) => r.id === 'keychain');
    const secretService = results.find((r) => r.id === 'secret-service');
    expect(keychain?.available).toBe(false);
    expect(secretService?.available).toBe(true);
  });
});
