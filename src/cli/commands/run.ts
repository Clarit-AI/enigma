import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { parseArgs, parseScope, UsageError } from '../args.js';
import { listSecrets, resolveSecret } from '../../storage/manager.js';
import { EnigmaError } from '../../core/errors.js';
import type { IndexEntryView, Scope } from '../../core/index-store.js';

const USAGE = 'enigma run [--only A,B] [--scope project|global] -- <command> [args...]';
const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

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
  const commandArgv = argv.slice(dashIdx + 1);
  if (commandArgv.length === 0) throw new UsageError(USAGE);

  const { flags } = parseArgs(argv.slice(0, dashIdx), { value: ['only', 'scope'] });
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
  return spawnChild(command!, commandArgs, childEnv);
}
