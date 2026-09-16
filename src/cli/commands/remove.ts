import { parseArgs, parseScope, UsageError } from '../args.js';
import { deleteSecret } from '../../storage/manager.js';

const USAGE = 'enigma remove NAME [--scope project|global]';

export async function cmdRemove(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { value: ['scope'] });
  const [name] = positionals;
  if (!name) throw new UsageError(USAGE);

  const scope = parseScope(flags.scope);
  await deleteSecret(name, { scope, cwd: process.cwd(), actor: 'cli' });

  process.stdout.write(`Removed ${name}${scope ? ` (${scope})` : ''}\n`);
  return 0;
}
