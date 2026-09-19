import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { parseArgs, parseScope, UsageError } from '../args.js';
import { listSecrets, resolveSecret } from '../../storage/manager.js';
import { EnigmaError } from '../../core/errors.js';
import type { IndexEntryView, Scope } from '../../core/index-store.js';

const USAGE = 'enigma run [--only A,B] [--scope project|global] -- <command> [args...]';
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Shell convention for "command not found"; mirrored in docs/api-contracts.md §3.
// Issue #22, AC #1.
const EXIT_BINARY_MISSING = 127;

function entriesToInject(entries: IndexEntryView[], only: string[] | undefined): IndexEntryView[] {
  const visible = only ? entries : entries.filter((e) => !e.shadowed);
  if (!only) return visible;

  const wanted = new Set(only);
  const matched = visible.filter((e) => wanted.has(e.name));
  const missing = only.filter((name) => !matched.some((e) => e.name === name));
  if (missing.length > 0) {
    throw new EnigmaError({ code: 'E_NOT_FOUND', message: `not found: ${missing.join(', ')}`, secretName: missing[0] });
  }
  return matched;
}

function spawnChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });

    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    const stopForwarding = (): void => {
      for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, forward);
    };

    child.on('error', (err) => {
      stopForwarding();
      reject(err);
    });
    child.on('exit', (code, signal) => {
      stopForwarding();
      if (signal) {
        const signum = (osConstants.signals as Record<string, number>)[signal] ?? 0;
        resolve(128 + signum);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function cmdRun(argv: string[]): Promise<number> {
  const dashIdx = argv.indexOf('--');
  if (dashIdx === -1) throw new UsageError(USAGE);
  // Reject any token before `--` that isn't a flag value (Issue #22, AC #2): a stray
  // positional like `enigma run foo -- cmd` used to be silently swallowed, leaving the
  // user with a child that runs without the secret injection they asked for. The parser
  // distinguishes flags from positionals; here we just refuse to accept any positionals.
  const prefixParsed = parseArgs(argv.slice(0, dashIdx), { value: ['only', 'scope'] });
  if (prefixParsed.positionals.length > 0) {
    throw new UsageError(`${USAGE}\n(stray positional before --: ${prefixParsed.positionals.join(' ')})`);
  }
  const commandArgv = argv.slice(dashIdx + 1);
  if (commandArgv.length === 0) throw new UsageError(USAGE);

  const { flags } = prefixParsed;
  const scope: Scope | 'all' = parseScope(flags.scope) ?? 'all';
  const only =
    typeof flags.only === 'string'
      ? flags.only
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
      : undefined;

  const cwd = process.cwd();
  const entries = entriesToInject(listSecrets({ scope, cwd }), only);

  // Resolve every value before spawning anything; any failure aborts with no child ever started.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of entries) {
    childEnv[entry.name] = await resolveSecret(entry.name, { scope: entry.scope, cwd, actor: 'cli' });
  }

  const [command, ...commandArgs] = commandArgv;
  try {
    return await spawnChild(command!, commandArgs, childEnv);
  } catch (err) {
    // Map Node's `spawn ENOENT` to a domain error with the shell-convention exit code 127,
    // a clear message naming the binary, and no value-derived text — Issue #22, AC #1.
    // We never throw with the raw `err.message` because a lower layer's wording could echo
    // something derived from an env var; the binary name is already a positional on the
    // command line, not a value.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new EnigmaError({
        code: 'E_BINARY_MISSING',
        message: `command not found: ${command}`,
        exitCode: EXIT_BINARY_MISSING,
      });
    }
    throw err;
  }
}
