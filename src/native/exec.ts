import { spawn } from 'node:child_process';
import { EnigmaError } from '../core/errors.js';

export interface ExecWithStdinOptions {
  timeoutMs: number;
  maxBufferBytes: number;
}

export interface ExecWithStdinResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `command` with `args` (an argv array; never a shell), feeding `input`
 * on stdin and closing it. Every OS integration receives its value this way,
 * never via argv (ADR-003, style-guide secret-handling conventions).
 */
export function execWithStdin(
  command: string,
  args: string[],
  input: string,
  opts: ExecWithStdinOptions,
): Promise<ExecWithStdinResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill('SIGKILL');
        reject(new EnigmaError({ code: 'E_UI_UNAVAILABLE', message: `${command} timed out after ${opts.timeoutMs}ms` }));
      });
    }, opts.timeoutMs);

    // stdout and stderr share opts.maxBufferBytes as one combined budget rather
    // than each getting their own cap: a per-stream cap would let a child push
    // combined memory usage up to 2x the intended limit by splitting output
    // across both streams without either single stream ever breaching its cap.
    const exceedsMaxBuffer = (): boolean =>
      Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > opts.maxBufferBytes;

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout += chunk.toString('utf8');
      if (exceedsMaxBuffer()) {
        finish(() => {
          child.kill('SIGKILL');
          reject(new EnigmaError({ code: 'E_UI_UNAVAILABLE', message: `${command} output exceeded max buffer` }));
        });
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderr += chunk.toString('utf8');
      if (exceedsMaxBuffer()) {
        finish(() => {
          child.kill('SIGKILL');
          reject(new EnigmaError({ code: 'E_UI_UNAVAILABLE', message: `${command} output exceeded max buffer` }));
        });
      }
    });

    child.on('error', () => {
      // Node's own message is safe (it names the command, never our input), but
      // wrap it for a stable code consistent with the timeout/maxBuffer paths.
      finish(() => reject(new EnigmaError({ code: 'E_UI_UNAVAILABLE', message: `${command} failed to start` })));
    });

    child.on('close', (code) => {
      finish(() => resolve({ code, stdout, stderr }));
    });

    child.stdin.on('error', () => {
      // e.g. EPIPE when the child exits before consuming stdin; surfaced via 'close'/'error' above.
    });
    child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
}
