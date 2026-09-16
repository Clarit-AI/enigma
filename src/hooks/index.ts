// Bundled hooks entrypoint (D3.3, ADR-004): `node dist/hooks.mjs <event>`, hook
// JSON on stdin, response on stdout. Every path here exits 0 — a hook that exits
// non-zero or throws would surface a raw error to the transcript, which is exactly
// the kind of leak this layer exists to prevent, and could block the user's work.
import { readStdinJson } from './stdin.js';
import { runSessionStart } from './session-start.js';
import { runReadGuard } from './read-guard.js';
import { runTripwire } from './tripwire.js';
import type { PostToolUseInput, PreToolUseInput, SessionStartInput } from './types.js';

/**
 * Dispatches one hook event to its handler and returns the value to print as
 * JSON on stdout, or `undefined` for "no output". Never throws: a thrown error
 * here would otherwise propagate past the one fail-open boundary this function
 * exists to be (mirrors `src/cli/index.ts`'s `main`, kept separate from the
 * process-exit side effect below so it can be tested directly).
 */
export async function dispatch(event: string | undefined, input: unknown): Promise<unknown> {
  try {
    switch (event) {
      case 'SessionStart':
        return runSessionStart(input as SessionStartInput);
      case 'PreToolUse':
        return runReadGuard(input as PreToolUseInput);
      case 'PostToolUse':
        return await runTripwire(input as PostToolUseInput);
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const input = await readStdinJson<unknown>().catch(() => ({}));
  const output = await dispatch(process.argv[2], input);
  if (output !== undefined) {
    process.stdout.write(JSON.stringify(output));
  }
  process.exit(0);
}

/* node:coverage disable */
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  void main();
}
/* node:coverage enable */
