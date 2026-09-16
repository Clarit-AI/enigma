import { execFile } from 'node:child_process';
import { EnigmaError } from '../../core/errors.js';
import type { Depository, DepositoryModule } from '../interfaces.js';

const SECRET_TOOL_BIN = 'secret-tool';
const SERVICE = 'enigma';
const EXEC_TIMEOUT_MS = 10_000;
const EXEC_MAX_BUFFER_BYTES = 1024 * 1024;
const PROBE_REF = '__enigma_detect_probe__';

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  stdout?: string;
  stderr?: string;
  code?: string | number;
}

/** Runs `secret-tool` with argv only, no stdin. */
function runSecretTool(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(SECRET_TOOL_BIN, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }) as ExecFailure);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Runs `secret-tool` with `value` supplied on stdin — never argv. */
function runSecretToolWithStdin(args: string[], value: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(SECRET_TOOL_BIN, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }) as ExecFailure);
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
    if (!child.stdin) {
      child.kill();
      reject(new Error('secret-tool: stdin unavailable'));
      return;
    }
    child.stdin.write(value);
    child.stdin.end();
  });
}

/** `secret-tool lookup`/`search` exit non-zero with no output when nothing matches — contacting the service still succeeded. */
function looksLikeNoResults(failure: ExecFailure): boolean {
  return (failure.stdout ?? '').trim() === '' && (failure.stderr ?? '').trim() === '' && typeof failure.code !== 'undefined';
}

/** Classifies a failed D-Bus/Secret Service call, ported from ClawVault's platform.ts. */
function classifyUnavailable(failure: ExecFailure): string {
  if (failure.code === 'ENOENT') return 'secret-tool not installed';
  const stderr = failure.stderr ?? '';
  if (stderr.includes('Object does not exist at path') || stderr.includes('/org/freedesktop/secrets/collection/login')) {
    return 'Secret Service default collection is missing';
  }
  if (
    stderr.includes('Cannot autolaunch D-Bus without X11 $DISPLAY') ||
    stderr.includes('Failed to execute child process') ||
    stderr.toLowerCase().includes('dbus')
  ) {
    return 'no D-Bus session bus available (headless environment)';
  }
  return 'secret-tool probe failed';
}

function readFailed(): never {
  throw new EnigmaError({
    code: 'E_READ_FAILED',
    message: 'failed to read secret from secret-service depository',
    depository: 'secret-service',
  });
}

function notFound(): never {
  throw new EnigmaError({ code: 'E_NOT_FOUND', message: 'secret not found', depository: 'secret-service' });
}

function createSecretServiceDepository(): Depository {
  return {
    id: 'secret-service',
    promptProfile: 'may-prompt',

    async set(ref, value) {
      try {
        await runSecretToolWithStdin(['store', `--label=enigma ${ref}`, 'service', SERVICE, 'ref', ref], value);
      } catch {
        readFailed();
      }
      return ref;
    },

    async resolve(ref) {
      try {
        const { stdout } = await runSecretTool(['lookup', 'service', SERVICE, 'ref', ref]);
        return stdout.replace(/\n$/, '');
      } catch (err) {
        const failure = err as ExecFailure;
        if (looksLikeNoResults(failure)) notFound();
        return readFailed();
      }
    },

    async delete(ref) {
      try {
        await runSecretTool(['clear', 'service', SERVICE, 'ref', ref]);
      } catch {
        // Idempotent on missing, matching the other depositories' delete().
      }
    },

    async has(ref) {
      try {
        await runSecretTool(['lookup', 'service', SERVICE, 'ref', ref]);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Store+clear write probe: `secret-tool` may be on PATH but unusable (no D-Bus session, missing default collection). */
async function probeWritable(): Promise<{ available: true } | { available: false; reason: string }> {
  try {
    await runSecretToolWithStdin(['store', '--label=enigma detect probe', 'service', SERVICE, 'ref', PROBE_REF], 'probe');
  } catch (err) {
    return { available: false, reason: classifyUnavailable(err as ExecFailure) };
  }
  try {
    await runSecretTool(['clear', 'service', SERVICE, 'ref', PROBE_REF]);
  } catch {
    // The probe secret was written; a failed clear doesn't change availability.
  }
  return { available: true };
}

export const linuxSecretServiceDepositoryModule: DepositoryModule = {
  id: 'secret-service',
  promptProfile: 'may-prompt',
  async detect() {
    if (process.platform !== 'linux') {
      return { id: 'secret-service', promptProfile: 'may-prompt', available: false, reason: 'not running on Linux' };
    }
    const probe = await probeWritable();
    return probe.available
      ? { id: 'secret-service', promptProfile: 'may-prompt', available: true }
      : { id: 'secret-service', promptProfile: 'may-prompt', available: false, reason: probe.reason };
  },
  create: createSecretServiceDepository,
};
