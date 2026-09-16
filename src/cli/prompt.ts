// Prompts for a secret value with terminal echo disabled, so it never appears
// on screen, in scrollback, or in any captured output (style-guide secret
// handling; this module is the CLI's one entry point for a brand-new value).

import { EnigmaError } from '../core/errors.js';

const ETX = '\x03'; // Ctrl+C
const BACKSPACE = '\x7f';
const CTRL_H = '\b';
const RAW_MODE_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

export interface PromptStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string) => void): unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<string | Buffer>;
}

export interface PromptWritable {
  write(chunk: string): unknown;
}

/** Reads one line (up to `\n`) from a non-TTY stdin, e.g. a pipe or redirected file. */
async function readOneLine(stdin: PromptStdin): Promise<string> {
  let buffered = '';
  const iterable = stdin as unknown as AsyncIterable<string | Buffer>;
  for await (const chunk of iterable) {
    buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const idx = buffered.indexOf('\n');
    if (idx !== -1) {
      const line = buffered.slice(0, idx);
      return line.endsWith('\r') ? line.slice(0, -1) : line;
    }
  }
  return buffered.endsWith('\r') ? buffered.slice(0, -1) : buffered;
}

/**
 * Reads one line from a TTY with echo disabled (raw mode), restoring the
 * terminal in a `finally`. SIGINT/SIGTERM are intercepted for the duration of
 * the read so the terminal is restored before the process exits; the signal
 * is then re-raised with its default disposition so the exit code stays
 * conventional (128 + signal number).
 */
async function readWithEchoDisabled(stdin: PromptStdin, stderr: PromptWritable): Promise<string> {
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode?.(true);
  stdin.setEncoding('utf8');
  stdin.resume();

  const restoreTerminal = (): void => {
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
  };

  let handleSignal: ((signal: NodeJS.Signals) => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            stdin.removeListener('data', onData);
            resolve(value);
            return;
          }
          if (ch === ETX) {
            stdin.removeListener('data', onData);
            reject(new Error('aborted'));
            return;
          }
          if (ch === BACKSPACE || ch === CTRL_H) {
            value = value.slice(0, -1);
            continue;
          }
          value += ch;
        }
      };
      stdin.on('data', onData);

      handleSignal = (signal: NodeJS.Signals): void => {
        stdin.removeListener('data', onData);
        for (const s of RAW_MODE_SIGNALS) process.removeListener(s, handleSignal!);
        restoreTerminal();
        process.kill(process.pid, signal);
      };
      for (const signal of RAW_MODE_SIGNALS) process.on(signal, handleSignal);
    });
  } finally {
    if (handleSignal) {
      for (const signal of RAW_MODE_SIGNALS) process.removeListener(signal, handleSignal);
    }
    restoreTerminal();
    stderr.write('\n');
  }
}

/**
 * Prompts on `stderr` and reads a secret value without ever echoing or
 * returning it via any other channel. Non-TTY stdin (pipes, CI) reads a
 * single line instead of attempting raw mode.
 *
 * On a TTY that cannot disable echo (`setRawMode` unavailable), this throws
 * `E_NO_TTY_CONTROL` before reading any input rather than falling back to a
 * read that would echo the secret to the screen.
 */
export async function promptSecretValue(
  promptText: string,
  streams: { stdin?: PromptStdin; stderr?: PromptWritable } = {},
): Promise<string> {
  const stdin = streams.stdin ?? (process.stdin as unknown as PromptStdin);
  const stderr = streams.stderr ?? process.stderr;
  if (!stdin.isTTY) {
    return readOneLine(stdin);
  }
  if (typeof stdin.setRawMode !== 'function') {
    throw new EnigmaError({
      code: 'E_NO_TTY_CONTROL',
      message: 'cannot disable terminal echo on this TTY: setRawMode is unavailable',
    });
  }
  stderr.write(promptText);
  return readWithEchoDisabled(stdin, stderr);
}
