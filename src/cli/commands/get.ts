// The human/script escape hatch (api-contracts.md §3); blocked for the agent by the PreToolUse read-guard (Issue #11).
import { parseArgs, parseScope, UsageError } from '../args.js';
import { resolveSecret } from '../../storage/manager.js';

const USAGE = 'enigma get NAME [--scope project|global]';

export async function cmdGet(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { value: ['scope'] });
  const [name] = positionals;
  if (!name) throw new UsageError(USAGE);

  const scope = parseScope(flags.scope);
  process.stderr.write(
    `warning: printing ${name} to stdout; prefer 'enigma run -- <cmd>' so the value never lands in your shell history or terminal scrollback\n`,
  );
  const value = await resolveSecret(name, { scope, cwd: process.cwd(), actor: 'cli' });
  process.stdout.write(`${value}\n`);
  return 0;
}
