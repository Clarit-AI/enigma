import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnigmaError } from '../../../src/core/errors.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

interface FakeCall {
  file: string;
  args: string[];
  stdinData?: string;
}

interface FakeError extends Error {
  code?: string | number;
  stdout?: string;
  stderr?: string;
}

const calls: FakeCall[] = [];
type Responder = (call: FakeCall) => { error?: FakeError | null; stdout?: string; stderr?: string };
let respond: Responder;

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const call: FakeCall = { file, args };
    calls.push(call);
    const result = respond(call);
    queueMicrotask(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
    return {
      stdin: {
        write: (data: string) => {
          call.stdinData = (call.stdinData ?? '') + data;
        },
        end: () => {},
      },
      kill: () => {},
    };
  },
}));

const { linuxSecretServiceDepositoryModule } = await import('../../../src/storage/depositories/linux-secret-service.js');

function okResult(stdout = ''): ReturnType<Responder> {
  return { stdout };
}

function noResultsError(): ReturnType<Responder> {
  const error = Object.assign(new Error('Command failed'), { code: 1 }) as FakeError;
  return { error, stdout: '', stderr: '' };
}

function dbusUnavailableError(): ReturnType<Responder> {
  const error = Object.assign(new Error('Command failed'), { code: 1 }) as FakeError;
  return { error, stdout: '', stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY for setting DBUS_SESSION_BUS_ADDRESS\n' };
}

function enoentError(): ReturnType<Responder> {
  const error = Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }) as FakeError;
  return { error, stdout: '', stderr: '' };
}

function genericError(): ReturnType<Responder> {
  const error = Object.assign(new Error('Command failed'), { code: 1 }) as FakeError;
  return { error, stdout: '', stderr: 'some unrelated failure text\n' };
}

let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('linux-secret-service depository', () => {
  beforeEach(() => {
    calls.length = 0;
    respond = () => okResult();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  describe('set', () => {
    it('runs secret-tool store with the value on stdin, never in argv, and returns the ref', async () => {
      respond = () => okResult();
      const depo = linuxSecretServiceDepositoryModule.create({});

      const ref = await depo.set('global/OPENAI_API_KEY', SENTINEL);

      expect(ref).toBe('global/OPENAI_API_KEY');
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.file).toBe('secret-tool');
      expect(call.args).toEqual(['store', '--label=enigma global/OPENAI_API_KEY', 'service', 'enigma', 'ref', 'global/OPENAI_API_KEY']);
      for (const arg of call.args) {
        expect(arg).not.toContain(SENTINEL);
      }
      expect(call.stdinData).toBe(SENTINEL);
    });

    it('throws E_READ_FAILED naming secret-service when the command fails', async () => {
      respond = () => genericError();
      const depo = linuxSecretServiceDepositoryModule.create({});

      await expect(depo.set('global/NAME', SENTINEL)).rejects.toThrow(
        expect.objectContaining({ code: 'E_READ_FAILED', depository: 'secret-service' }),
      );
    });
  });

  describe('resolve', () => {
    it('runs secret-tool lookup with no stdin and trims the trailing newline', async () => {
      respond = () => okResult(`${SENTINEL}\n`);
      const depo = linuxSecretServiceDepositoryModule.create({});

      const value = await depo.resolve('global/OPENAI_API_KEY');

      expect(value).toBe(SENTINEL);
      expect(calls[0]!.args).toEqual(['lookup', 'service', 'enigma', 'ref', 'global/OPENAI_API_KEY']);
      expect(calls[0]!.stdinData).toBeUndefined();
    });

    it('throws E_NOT_FOUND when nothing matches', async () => {
      respond = () => noResultsError();
      const depo = linuxSecretServiceDepositoryModule.create({});

      await expect(depo.resolve('global/MISSING')).rejects.toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }));
    });

    it('throws E_READ_FAILED naming secret-service on any other failure, never including the value', async () => {
      respond = () => genericError();
      const depo = linuxSecretServiceDepositoryModule.create({});

      try {
        await depo.resolve('global/NAME');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(EnigmaError);
        expect((err as EnigmaError).code).toBe('E_READ_FAILED');
        expect((err as EnigmaError).depository).toBe('secret-service');
        expect((err as EnigmaError).message).not.toContain(SENTINEL);
      }
    });
  });

  describe('delete', () => {
    it('runs secret-tool clear with only the ref in argv', async () => {
      respond = () => okResult();
      const depo = linuxSecretServiceDepositoryModule.create({});

      await depo.delete('global/NAME');

      expect(calls[0]!.args).toEqual(['clear', 'service', 'enigma', 'ref', 'global/NAME']);
    });

    it('is idempotent when the item is missing', async () => {
      respond = () => noResultsError();
      const depo = linuxSecretServiceDepositoryModule.create({});

      await expect(depo.delete('global/MISSING')).resolves.toBeUndefined();
    });
  });

  describe('has', () => {
    it('returns true when found', async () => {
      respond = () => okResult(`${SENTINEL}\n`);
      const depo = linuxSecretServiceDepositoryModule.create({});
      await expect(depo.has('global/NAME')).resolves.toBe(true);
    });

    it('returns false when missing', async () => {
      respond = () => noResultsError();
      const depo = linuxSecretServiceDepositoryModule.create({});
      await expect(depo.has('global/NAME')).resolves.toBe(false);
    });
  });

  describe('detect', () => {
    it('is available on linux when the store+clear probe succeeds', async () => {
      setPlatform('linux');
      respond = () => okResult();

      const result = await linuxSecretServiceDepositoryModule.detect();

      expect(result).toEqual({ id: 'secret-service', promptProfile: 'may-prompt', available: true });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.args[0]).toBe('store');
      expect(calls[1]!.args[0]).toBe('clear');
    });

    it('is unavailable when secret-tool is not installed', async () => {
      setPlatform('linux');
      respond = () => enoentError();

      const result = await linuxSecretServiceDepositoryModule.detect();

      expect(result.available).toBe(false);
      expect(result.reason).toContain('not installed');
    });

    it('is unavailable with a headless reason when D-Bus is unreachable', async () => {
      setPlatform('linux');
      respond = () => dbusUnavailableError();

      const result = await linuxSecretServiceDepositoryModule.detect();

      expect(result.available).toBe(false);
      expect(result.reason).toContain('D-Bus');
    });

    it('is unavailable on non-linux platforms without invoking secret-tool', async () => {
      setPlatform('darwin');

      const result = await linuxSecretServiceDepositoryModule.detect();

      expect(result.available).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  it('registers promptProfile may-prompt on the module', () => {
    expect(linuxSecretServiceDepositoryModule.promptProfile).toBe('may-prompt');
    expect(linuxSecretServiceDepositoryModule.id).toBe('secret-service');
  });
});

describe('linux-secret-service source', () => {
  it('never calls security dump-keychain', () => {
    const sourcePath = fileURLToPath(new URL('../../../src/storage/depositories/linux-secret-service.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/dump-keychain/);
  });
});

const RUN_E2E = process.env.ENIGMA_E2E === '1' && process.platform === 'linux';

// Opt-in real-OS round-trip (ENIGMA_E2E=1, Linux only): exercises the actual
// secret-tool binary against the real Secret Service, using a unique,
// disposable ref that is always deleted afterward.
describe.runIf(RUN_E2E)('linux-secret-service E2E (real OS)', () => {
  it('round-trips a value containing quotes, backslashes, dollar signs, and newlines', async () => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    const real = await import('../../../src/storage/depositories/linux-secret-service.js');
    const depo = real.linuxSecretServiceDepositoryModule.create({});
    const ref = `global/ENIGMA_E2E_TEST_${Date.now()}`;
    const value = 'has "quotes" and \\backslash and $dollar\nand a newline\r\nand crlf';

    try {
      await expect(depo.set(ref, value)).resolves.toBe(ref);
      await expect(depo.resolve(ref)).resolves.toBe(value);
      await expect(depo.has(ref)).resolves.toBe(true);
    } finally {
      await depo.delete(ref);
    }

    await expect(depo.has(ref)).resolves.toBe(false);
  });
});
