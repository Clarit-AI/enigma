import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EnigmaError } from '../../core/errors.js';
import type { Depository, DepositoryModule } from '../interfaces.js';

const SECURITY_BIN = '/usr/bin/security';
const SERVICE = 'enigma';
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER_BYTES = 1024 * 1024;
const NOT_FOUND_PATTERN = /could not be found/i;
/** `security`'s exit status for errSecItemNotFound — stable across system languages, unlike its stderr text. */
const ERR_SEC_ITEM_NOT_FOUND = 44;

/** `security -i` reads each batch command as a single line capped at this many bytes. */
const BATCH_LINE_MAX_BYTES = 4096;

/** `ref` is a depository-boundary input; validated before any process is spawned (Issue #6 will pass externally-derived ids here). */
const REF_PATTERN = /^[A-Za-z0-9_./-]+$/;
const REF_MAX_LENGTH = 512;

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

/**
 * Runs `security -i` (batch/interactive mode) with `line` as its one command,
 * supplied on stdin — never argv. `error` listeners on both the child and
 * its stdin turn a pipe failure (e.g. the child exiting before stdin
 * drains) into a rejected promise instead of an uncaught exception that
 * would crash the process; `write()`'s backpressure signal is honoured
 * rather than ending stdin while a write is still buffered.
 */
function runSecurityBatch(line: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(SECURITY_BIN, ['-i'], { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }) as ExecFailure);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    child.on('error', reject);
    if (!child.stdin) {
      child.kill();
      reject(new Error('security -i: stdin unavailable'));
      return;
    }
    child.stdin.on('error', reject);
    if (child.stdin.write(`${line}\n`)) {
      child.stdin.end();
    } else {
      child.stdin.once('drain', () => child.stdin?.end());
    }
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
  return readFailed();
}

/**
 * The exact byte overhead of the `add-generic-password` batch line around
 * its hex payload, for a given `ref`. Computing this before spawning
 * anything lets `set` reject an oversized value up front instead of
 * leaving a truncated, marker-less orphan item behind once `security -i`
 * truncates the line mid-command.
 */
function batchLineOverheadBytes(ref: string): number {
  return Buffer.byteLength(`add-generic-password -a ${ref} -s ${SERVICE} -X  -U\n`, 'utf8');
}

/** Maximum plaintext value byte length that fits within the batch-line budget for `ref`. */
export function maxValueBytes(ref: string): number {
  const hexBudget = BATCH_LINE_MAX_BYTES - batchLineOverheadBytes(ref);
  return Math.floor(hexBudget / 2) - 1; // 2 hex chars/byte, minus the trailing marker byte
}

function readFailed(): never {
  throw new EnigmaError({
    code: 'E_READ_FAILED',
    message: 'failed to read secret from keychain depository',
    depository: 'keychain',
  });
}

function writeFailed(): never {
  throw new EnigmaError({
    code: 'E_WRITE_FAILED',
    message: 'failed to write secret to keychain depository',
    depository: 'keychain',
  });
}

function notFound(): never {
  throw new EnigmaError({ code: 'E_NOT_FOUND', message: 'secret not found', depository: 'keychain' });
}

function refInvalid(): never {
  throw new EnigmaError({
    code: 'E_REF_INVALID',
    message: `invalid depository ref: expected ${REF_PATTERN} and at most ${REF_MAX_LENGTH} characters`,
    depository: 'keychain',
  });
}

function valueTooLarge(limitBytes: number): never {
  throw new EnigmaError({
    code: 'E_VALUE_TOO_LARGE',
    message: `value exceeds the keychain depository's ${limitBytes}-byte limit; use the "encrypted" depository for large material such as PEM keys`,
    depository: 'keychain',
  });
}

function validateRef(ref: string): void {
  if (ref.length === 0 || ref.length > REF_MAX_LENGTH || !REF_PATTERN.test(ref)) {
    refInvalid();
  }
}

function isItemNotFound(failure: ExecFailure): boolean {
  return (
    failure.code === ERR_SEC_ITEM_NOT_FOUND ||
    NOT_FOUND_PATTERN.test(failure.stderr ?? '') ||
    NOT_FOUND_PATTERN.test(failure.message ?? '')
  );
}

function createKeychainDepository(): Depository {
  return {
    id: 'keychain',
    promptProfile: 'may-prompt',

    async set(ref, value) {
      validateRef(ref);
      const limit = maxValueBytes(ref);
      if (Buffer.byteLength(value, 'utf8') > limit) {
        valueTooLarge(limit);
      }
      const hex = encodeSecretHex(value);
      try {
        await runSecurityBatch(`add-generic-password -a ${ref} -s ${SERVICE} -X ${hex} -U`);
      } catch {
        writeFailed();
      }
      return ref;
    },

    async resolve(ref) {
      validateRef(ref);
      try {
        const { stdout } = await runSecurity(['find-generic-password', '-a', ref, '-s', SERVICE, '-w']);
        return decodeSecretOutput(stdout);
      } catch (err) {
        const failure = err as ExecFailure;
        if (isItemNotFound(failure)) {
          notFound();
        }
        return readFailed();
      }
    },

    async delete(ref) {
      validateRef(ref);
      try {
        await runSecurity(['delete-generic-password', '-a', ref, '-s', SERVICE]);
      } catch (err) {
        const failure = err as ExecFailure;
        if (isItemNotFound(failure)) {
          return;
        }
        readFailed();
      }
    },

    async has(ref) {
      validateRef(ref);
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
