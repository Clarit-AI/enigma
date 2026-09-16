// Prompts for a secret value with terminal echo disabled, so it never appears
// on screen, in scrollback, or in any captured output (style-guide secret
// handling; this module is the CLI's one entry point for a brand-new value).

const ETX = ''; // Ctrl+C
const BACKSPACE = '';
const CTRL_H = '\b';

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

/** Reads one line from a TTY with echo disabled (raw mode), restoring the terminal in a `finally`. */
async function readWithEchoDisabled(stdin: PromptStdin, stderr: PromptWritable): Promise<string> {
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode?.(true);
  stdin.setEncoding('utf8');
  stdin.resume();
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
    });
  } finally {
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
    stderr.write('\n');
  }
}

/**
 * Prompts on `stderr` and reads a secret value without ever echoing or
 * returning it via any other channel. Non-TTY stdin (pipes, CI) reads a
 * single line instead of attempting raw mode.
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
  stderr.write(promptText);
  return readWithEchoDisabled(stdin, stderr);
}
