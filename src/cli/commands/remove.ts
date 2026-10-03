import { parseArgs, parseScope, UsageError } from '../args.js';
import { deleteSecret } from '../../storage/manager.js';

const USAGE = 'enigma remove NAME [--scope project|global]';

export async function cmdRemove(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { value: ['scope'] });
  const [name] = positionals;
  if (!name) throw new UsageError(USAGE);

  const scope = parseScope(flags.scope);
  const result = await deleteSecret(name, { scope, cwd: process.cwd(), actor: 'cli' });

  process.stdout.write(`Removed ${name}${scope ? ` (${scope})` : ''}\n`);
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  return 0;
}
