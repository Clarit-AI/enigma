import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

/**
 * Default safety net: no test spawns a real child process unless it opts in.
 *
 * A depository's `detect()` (currently only `1password`, via `op`) shells
 * out. Registering a depository in `DEPOSITORY_MODULES` makes it reachable
 * from `detectAll()` — and therefore from every test that happens to touch
 * that, directly or transitively (the CLI dispatcher, `doctor`, the request
 * form's depository picker), not just the depository's own test file. A
 * test file that never anticipated a *future* depository shelling out has
 * no reason to mock `child_process`, so without this guard each new
 * shell-based depository silently starts spawning real processes from
 * every test that reaches `detectAll()` — different behaviour on a machine
 * with the binary installed and signed in, one with it installed but
 * signed out, and one without it at all. This closes that door once,
 * structurally, rather than patching each file that happens to call
 * `detectAll()` today.
 *
 * A test file that needs fine-grained control over `child_process`
 * (asserting exact argv/stdin, simulating specific failures) calls its own
 * `vi.mock('node:child_process', ...)`, which — because `vi.mock` calls are
 * hoisted to the top of that file — takes precedence over this default
 * within that file.
 *
 * Bypassed entirely under the opt-in E2E env vars, which intentionally want
 * the real binary.
 */
const REAL_E2E = process.env.ENIGMA_E2E === '1' || process.env.ENIGMA_E2E_OP === '1';

// vi.mock must be an unconditional top-level call to be hoisted correctly;
// the opt-out for the real E2E specs lives inside the factory instead.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  if (REAL_E2E) return actual;
  // Only `execFile` (the async API every depository uses) is intercepted.
  // Everything else — `execFileSync`, `spawn`, … — passes through to the
  // real module, so a test with its own legitimate, unrelated reason to
  // spawn a real subprocess (e.g. running scripts/leak-fence.mjs as a
  // static-analysis integration check) is unaffected by this guard.
  return {
    ...actual,
    execFile: (_file: string, _args: unknown[], _options: unknown, callback: (...cbArgs: unknown[]) => void) => {
      const stdin = new EventEmitter() as EventEmitter & { write: (data: string) => boolean; end: () => void };
      stdin.write = () => true;
      stdin.end = () => {};
      const error = Object.assign(
        new Error('execFile blocked by the default test guard (test/setup.ts); mock node:child_process locally in this file to exercise a specific command'),
        { code: 'ENOENT' },
      );
      queueMicrotask(() => callback(error, '', ''));
      const child = new EventEmitter() as EventEmitter & { stdin: typeof stdin; kill: () => void };
      child.stdin = stdin;
      child.kill = () => {};
      return child;
    },
  };
});

