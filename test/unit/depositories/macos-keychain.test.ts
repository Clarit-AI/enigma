import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnigmaError } from '../../../src/core/errors.js';

const SENTINEL = 'sk-sentinel-value-should-never-appear';

interface FakeStdin extends EventEmitter {
  write: (data: string) => boolean;
  end: () => void;
}

interface FakeCall {
  file: string;
  args: string[];
  stdinData: string;
  stdin: FakeStdin;
  writeReturn: boolean;
}

type RespondResult = {
  error?: (NodeJS.ErrnoException & { stdout?: string; stderr?: string }) | null;
  stdout?: string;
  stderr?: string;
  /** When set, the mock emits this as an 'error' event on the child's stdin instead of invoking the exec callback. */
  stdinError?: Error;
};

const calls: FakeCall[] = [];
let respond: (call: FakeCall) => RespondResult;

vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
    const stdin = new EventEmitter() as FakeStdin;
    const call: FakeCall = { file, args, stdinData: '', stdin, writeReturn: true };
    stdin.write = (data: string) => {
      call.stdinData += data;
      return call.writeReturn;
    };
    stdin.end = () => {};
    calls.push(call);
    const result = respond(call);
    if (result.stdinError) {
      queueMicrotask(() => stdin.emit('error', result.stdinError));
    } else {
      queueMicrotask(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
    }
    const child = new EventEmitter() as EventEmitter & { stdin: FakeStdin; kill: () => void };
    child.stdin = stdin;
    child.kill = () => {};
    return child;
  },
}));

const existsSyncMock = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (...args: unknown[]) => existsSyncMock(...args) };
});

const { macosKeychainDepositoryModule, encodeSecretHex, decodeSecretOutput, maxValueBytes } = await import(
  '../../../src/storage/depositories/macos-keychain.js'
);

function okResult(stdout = ''): ReturnType<typeof respond> {
  return { stdout };
}

function notFoundError(): ReturnType<typeof respond> {
  const error = new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.') as NodeJS.ErrnoException;
  return { error, stderr: 'The specified item could not be found in the keychain.\n' };
}

/** errSecItemNotFound (44) with a non-English, non-matching stderr string — proves detection uses the exit status, not locale text. */
function notFoundByExitCodeError(): ReturnType<typeof respond> {
  const error = Object.assign(new Error('security: some localized failure text'), { code: 44 }) as NodeJS.ErrnoException & { code: number };
  return { error, stderr: 'un texte localisé sans rapport\n' };
}

function genericError(): ReturnType<typeof respond> {
  const error = new Error('security: some other failure') as NodeJS.ErrnoException;
  return { error, stderr: 'some other failure\n' };
}

let originalPlatform: PropertyDescriptor | undefined;

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('macos-keychain depository', () => {
  beforeEach(() => {
    calls.length = 0;
    respond = () => okResult();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    // Cleared per-test so a detect() assertion about this test's own calls
    // isn't perturbed by an unrelated caller (e.g. another registered
    // depository's detect() probing the filesystem) that also runs through
    // this shared mock within the same process.
    existsSyncMock.mockClear();
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  describe('encodeSecretHex / decodeSecretOutput', () => {
    it('round-trips a plain value', () => {
      expect(decodeSecretOutput(`${encodeSecretHex('plain-value')}\n`)).toBe('plain-value');
    });

    it('throws E_READ_FAILED instead of guessing when stdout is not hex-and-marker encoded', () => {
      expect(() => decodeSecretOutput('not-hex-output\n')).toThrow(
        expect.objectContaining({ code: 'E_READ_FAILED', depository: 'keychain' }),
      );
    });

    it('throws E_READ_FAILED for well-formed hex missing the trailing marker byte', () => {
      const unmarked = Buffer.from('plain-value', 'utf8').toString('hex');
      expect(() => decodeSecretOutput(`${unmarked}\n`)).toThrow(expect.objectContaining({ code: 'E_READ_FAILED' }));
    });

    it('round-trips quotes, backslashes, and dollar signs', () => {
      const value = 'a"b\\c$d';
      expect(decodeSecretOutput(`${encodeSecretHex(value)}\n`)).toBe(value);
    });

    it('round-trips embedded newlines and carriage returns', () => {
      const value = 'line1\nline2\r\nline3';
      expect(decodeSecretOutput(`${encodeSecretHex(value)}\n`)).toBe(value);
    });

    it('round-trips an empty value', () => {
      expect(decodeSecretOutput(`${encodeSecretHex('')}\n`)).toBe('');
    });

    it('round-trips unicode', () => {
      const value = 'sécrét-🔑-値';
      expect(decodeSecretOutput(`${encodeSecretHex(value)}\n`)).toBe(value);
    });
  });

  describe('set', () => {
    it('runs security -i with the value on stdin, never in argv, and returns the ref', async () => {
      respond = () => okResult();
      const depo = macosKeychainDepositoryModule.create({});

      const ref = await depo.set('global/OPENAI_API_KEY', SENTINEL);

      expect(ref).toBe('global/OPENAI_API_KEY');
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.file).toBe('/usr/bin/security');
      expect(call.args).toEqual(['-i']);
      for (const arg of call.args) {
        expect(arg).not.toContain(SENTINEL);
      }
      expect(call.stdinData).not.toContain(SENTINEL);
      expect(call.stdinData).toContain('add-generic-password -a global/OPENAI_API_KEY -s enigma -X');
      expect(call.stdinData).toContain('-U');

      const hexMatch = call.stdinData.match(/-X ([0-9a-f]+) -U/);
      expect(hexMatch).not.toBeNull();
      expect(decodeSecretOutput(`${hexMatch![1]}\n`)).toBe(SENTINEL);
    });

    it('handles values containing quotes, backslashes, dollar signs, and newlines without corruption', async () => {
      const value = 'a"b\\c$d\ne\'f\r\ng';
      respond = () => okResult();
      const depo = macosKeychainDepositoryModule.create({});

      await depo.set('global/NAME', value);

      const hexMatch = calls[0]!.stdinData.match(/-X ([0-9a-f]+) -U/);
      expect(decodeSecretOutput(`${hexMatch![1]}\n`)).toBe(value);
    });

    it('throws E_WRITE_FAILED naming keychain when the security command fails', async () => {
      respond = () => genericError();
      const depo = macosKeychainDepositoryModule.create({});

      await expect(depo.set('global/NAME', SENTINEL)).rejects.toThrow(
        expect.objectContaining({ code: 'E_WRITE_FAILED', depository: 'keychain' }),
      );
    });

    it('rejects instead of crashing when the child exits before stdin drains (EPIPE)', async () => {
      respond = () => ({ stdinError: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) });
      const depo = macosKeychainDepositoryModule.create({});

      await expect(depo.set('global/NAME', SENTINEL)).rejects.toThrow(
        expect.objectContaining({ code: 'E_WRITE_FAILED', depository: 'keychain' }),
      );
    });
  });

  describe('set — value size limit', () => {
    it('accepts a value exactly at the batch-line byte boundary', async () => {
      respond = () => okResult();
      const depo = macosKeychainDepositoryModule.create({});
      const ref = 'global/NAME';
      const limit = maxValueBytes(ref);

      await expect(depo.set(ref, 'A'.repeat(limit))).resolves.toBe(ref);
      expect(calls).toHaveLength(1);
    });

    it('rejects a value one byte past the boundary with E_VALUE_TOO_LARGE, before spawning anything', async () => {
      const depo = macosKeychainDepositoryModule.create({});
      const ref = 'global/NAME';
      const limit = maxValueBytes(ref);
      const value = 'A'.repeat(limit + 1);

      try {
        await depo.set(ref, value);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(EnigmaError);
        expect((err as EnigmaError).code).toBe('E_VALUE_TOO_LARGE');
        expect((err as EnigmaError).depository).toBe('keychain');
        expect((err as EnigmaError).message).toContain(String(limit));
        expect((err as EnigmaError).message).toContain('encrypted');
        expect((err as EnigmaError).message).not.toContain(value);
      }
    });

    it('leaves no keychain item behind after a rejected oversized write', async () => {
      const depo = macosKeychainDepositoryModule.create({});
      const ref = 'global/NAME';
      const limit = maxValueBytes(ref);

      await expect(depo.set(ref, 'A'.repeat(limit + 1))).rejects.toThrow(
        expect.objectContaining({ code: 'E_VALUE_TOO_LARGE' }),
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('ref validation', () => {
    it('rejects an invalid ref on set/resolve/delete/has before spawning anything', async () => {
      const depo = macosKeychainDepositoryModule.create({});
      const invalidRef = 'global/NAME; rm -rf /';

      await expect(depo.set(invalidRef, SENTINEL)).rejects.toThrow(expect.objectContaining({ code: 'E_REF_INVALID' }));
      await expect(depo.resolve(invalidRef)).rejects.toThrow(expect.objectContaining({ code: 'E_REF_INVALID' }));
      await expect(depo.delete(invalidRef)).rejects.toThrow(expect.objectContaining({ code: 'E_REF_INVALID' }));
      await expect(depo.has(invalidRef)).rejects.toThrow(expect.objectContaining({ code: 'E_REF_INVALID' }));
      expect(calls).toHaveLength(0);
    });

    it('rejects a ref longer than the sane cap', async () => {
      const depo = macosKeychainDepositoryModule.create({});
      const longRef = `global/${'A'.repeat(600)}`;

      await expect(depo.set(longRef, SENTINEL)).rejects.toThrow(expect.objectContaining({ code: 'E_REF_INVALID' }));
      expect(calls).toHaveLength(0);
    });
  });

  describe('resolve', () => {
    it('runs find-generic-password with -w and no stdin, decoding the hex result', async () => {
      const hex = encodeSecretHex(SENTINEL);
      respond = () => okResult(`${hex}\n`);
      const depo = macosKeychainDepositoryModule.create({});

      const value = await depo.resolve('global/OPENAI_API_KEY');

      expect(value).toBe(SENTINEL);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual(['find-generic-password', '-a', 'global/OPENAI_API_KEY', '-s', 'enigma', '-w']);
      expect(calls[0]!.stdinData).toBe('');
    });

    it('throws E_NOT_FOUND when the item is missing', async () => {
      respond = () => notFoundError();
      const depo = macosKeychainDepositoryModule.create({});

      await expect(depo.resolve('global/MISSING')).rejects.toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }));
    });

    it('throws E_NOT_FOUND from the exit status (44) even when stderr text does not match, regardless of locale', async () => {
      respond = () => notFoundByExitCodeError();
      const depo = macosKeychainDepositoryModule.create({});

      await expect(depo.resolve('global/MISSING')).rejects.toThrow(expect.objectContaining({ code: 'E_NOT_FOUND' }));
    });

    it('throws E_READ_FAILED naming keychain on any other failure, never including the value', async () => {
      respond = () => genericError();
      const depo = macosKeychainDepositoryModule.create({});

      try {
        await depo.resolve('global/NAME');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(EnigmaError);
        expect((err as EnigmaError).code).toBe('E_READ_FAILED');
        expect((err as EnigmaError).depository).toBe('keychain');
        expect((err as EnigmaError).message).not.toContain(SENTINEL);
      }
    });
  });

  describe('delete', () => {
    it('runs delete-generic-password with only the ref in argv', async () => {
      respond = () => okResult();
      const depo = macosKeychainDepositoryModule.create({});

      await depo.delete('global/NAME');

      expect(calls[0]!.args).toEqual(['delete-generic-password', '-a', 'global/NAME', '-s', 'enigma']);
    });

    it('is idempotent when the item is missing', async () => {
      respond = () => notFoundError();
      const depo = macosKeychainDepositoryModule.create({});

      await expect(depo.delete('global/MISSING')).resolves.toBeUndefined();
    });

    it('is idempotent when the item is missing, detected via exit status regardless of locale', async () => {
      respond = () => notFoundByExitCodeError();
      const depo = macosKeychainDepositoryModule.create({});

      await expect(depo.delete('global/MISSING')).resolves.toBeUndefined();
    });

    it('throws E_READ_FAILED on a non-missing failure', async () => {
      respond = () => genericError();
      const depo = macosKeychainDepositoryModule.create({});

      await expect(depo.delete('global/NAME')).rejects.toThrow(expect.objectContaining({ code: 'E_READ_FAILED' }));
    });
  });

  describe('has', () => {
    it('returns true when found', async () => {
      respond = () => okResult();
      const depo = macosKeychainDepositoryModule.create({});
      await expect(depo.has('global/NAME')).resolves.toBe(true);
    });

    it('returns false when missing', async () => {
      respond = () => notFoundError();
      const depo = macosKeychainDepositoryModule.create({});
      await expect(depo.has('global/NAME')).resolves.toBe(false);
    });
  });

  describe('detect', () => {
    it('is available on darwin when /usr/bin/security exists, and never touches child_process', async () => {
      setPlatform('darwin');
      existsSyncMock.mockReturnValue(true);

      const result = await macosKeychainDepositoryModule.detect();

      expect(result).toEqual({ id: 'keychain', promptProfile: 'may-prompt', available: true });
      expect(calls).toHaveLength(0);
      expect(existsSyncMock).toHaveBeenCalledWith('/usr/bin/security');
    });

    it('is unavailable on darwin when /usr/bin/security is missing', async () => {
      setPlatform('darwin');
      existsSyncMock.mockReturnValue(false);

      const result = await macosKeychainDepositoryModule.detect();

      expect(result.available).toBe(false);
      expect(result.reason).toContain('/usr/bin/security');
    });

    it('is unavailable on non-darwin platforms without checking the filesystem', async () => {
      setPlatform('linux');

      const result = await macosKeychainDepositoryModule.detect();

      expect(result.available).toBe(false);
      expect(existsSyncMock).not.toHaveBeenCalled();
    });
  });

  it('registers promptProfile may-prompt on the module', () => {
    expect(macosKeychainDepositoryModule.promptProfile).toBe('may-prompt');
    expect(macosKeychainDepositoryModule.id).toBe('keychain');
  });
});

describe('macos-keychain source', () => {
  it('never calls security dump-keychain', () => {
    const sourcePath = fileURLToPath(new URL('../../../src/storage/depositories/macos-keychain.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/dump-keychain/);
  });
});

const RUN_E2E = process.env.ENIGMA_E2E === '1' && process.platform === 'darwin';

// Opt-in real-OS round-trip (ENIGMA_E2E=1, macOS only): exercises the actual
// /usr/bin/security binary against the real default keychain, using a
// unique, disposable ref that is always deleted afterward.
describe.runIf(RUN_E2E)('macos-keychain E2E (real OS)', () => {
  it('round-trips a value containing quotes, backslashes, dollar signs, and newlines', async () => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.resetModules();
    const real = await import('../../../src/storage/depositories/macos-keychain.js');
    const depo = real.macosKeychainDepositoryModule.create({});
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

  it('rejects an oversized value and leaves no orphan item in the real keychain', async () => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.resetModules();
    const real = await import('../../../src/storage/depositories/macos-keychain.js');
    const depo = real.macosKeychainDepositoryModule.create({});
    const ref = `global/ENIGMA_E2E_TOOLARGE_${Date.now()}`;
    const limit = real.maxValueBytes(ref);

    await expect(depo.set(ref, 'A'.repeat(limit + 1))).rejects.toThrow(
      expect.objectContaining({ code: 'E_VALUE_TOO_LARGE' }),
    );
    await expect(depo.has(ref)).resolves.toBe(false);
  });
});
