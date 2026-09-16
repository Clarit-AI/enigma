import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EnigmaError } from '../../core/errors.js';
import type { Depository, DepositoryModule } from '../interfaces.js';

const SECURITY_BIN = '/usr/bin/security';
const SERVICE = 'enigma';
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER_BYTES = 1024 * 1024;
const NOT_FOUND_PATTERN = /could not be found/i;

/**
 * A trailing sentinel byte appended to every stored value. `security -i`'s
 * batch reader is line-oriented, so a literal `-w "<value>"` argument can
 * never safely carry a value containing a raw newline (it truncates the
 * command) or reliably distinguish quote/backslash edge cases from its own
 * escape syntax. Storing the value via `-X <hex>` instead sidesteps that
 * parser entirely — hex digits need no quoting — and this marker byte
 * guarantees `find-generic-password -w` always answers in its hex-dump
 * form (it switches to hex only when the stored bytes contain a
 * non-printable byte), so decoding never has to guess whether stdout was
 * hex or literal text.
 */
const MARKER_BYTE = 0x01;

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number;
}

function runSecurity(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(SECURITY_BIN, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }) as ExecFailure);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Runs `security -i` (batch/interactive mode) with `line` as its one command, supplied on stdin — never argv. */
function runSecurityBatch(line: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(SECURITY_BIN, ['-i'], { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }) as ExecFailure);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    if (!child.stdin) {
      child.kill();
      reject(new Error('security -i: stdin unavailable'));
      return;
    }
    child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

/** Encodes `value` as the hex string given to `add-generic-password -X`, with the trailing marker byte. */
export function encodeSecretHex(value: string): string {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([MARKER_BYTE])]).toString('hex');
}

/**
 * Inverse of `encodeSecretHex`, applied to `find-generic-password -w`'s
 * stdout. Every item this depository creates carries the marker byte, so
 * `security` always answers in hex; a value without the marker byte after
 * decoding means the hex string wasn't ours (or the item predates this
 * depository), so it is returned unmodified rather than guessed at.
 */
export function decodeSecretOutput(stdout: string): string {
  const trimmed = stdout.replace(/\n$/, '');
  if (/^[0-9a-fA-F]*$/.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length > 0) {
    const bytes = Buffer.from(trimmed, 'hex');
    if (bytes[bytes.length - 1] === MARKER_BYTE) {
      return bytes.subarray(0, bytes.length - 1).toString('utf8');
    }
  }
  return trimmed;
}

function readFailed(): never {
  throw new EnigmaError({
    code: 'E_READ_FAILED',
    message: 'failed to read secret from keychain depository',
    depository: 'keychain',
  });
}

function notFound(): never {
  throw new EnigmaError({ code: 'E_NOT_FOUND', message: 'secret not found', depository: 'keychain' });
}

function createKeychainDepository(): Depository {
  return {
    id: 'keychain',
    promptProfile: 'may-prompt',

    async set(ref, value) {
      const hex = encodeSecretHex(value);
      try {
        await runSecurityBatch(`add-generic-password -a ${ref} -s ${SERVICE} -X ${hex} -U`);
      } catch {
        readFailed();
      }
      return ref;
    },

    async resolve(ref) {
      try {
        const { stdout } = await runSecurity(['find-generic-password', '-a', ref, '-s', SERVICE, '-w']);
        return decodeSecretOutput(stdout);
      } catch (err) {
        const failure = err as ExecFailure;
        if (NOT_FOUND_PATTERN.test(failure.stderr ?? '') || NOT_FOUND_PATTERN.test(failure.message ?? '')) {
          notFound();
        }
        return readFailed();
      }
    },

    async delete(ref) {
      try {
        await runSecurity(['delete-generic-password', '-a', ref, '-s', SERVICE]);
      } catch (err) {
        const failure = err as ExecFailure;
        if (NOT_FOUND_PATTERN.test(failure.stderr ?? '') || NOT_FOUND_PATTERN.test(failure.message ?? '')) {
          return;
        }
        readFailed();
      }
    },

    async has(ref) {
      try {
        await runSecurity(['find-generic-password', '-a', ref, '-s', SERVICE]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const macosKeychainDepositoryModule: DepositoryModule = {
  id: 'keychain',
  promptProfile: 'may-prompt',
  async detect() {
    if (process.platform !== 'darwin') {
      return { id: 'keychain', promptProfile: 'may-prompt', available: false, reason: 'not running on macOS' };
    }
    const available = existsSync(SECURITY_BIN);
    return {
      id: 'keychain',
      promptProfile: 'may-prompt',
      available,
      reason: available ? undefined : `${SECURITY_BIN} not found`,
    };
  },
  create: createKeychainDepository,
};
