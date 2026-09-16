import { parseArgs, parseScope, parseUsage, UsageError } from '../args.js';
import { promptSecretValue, type PromptStdin, type PromptWritable } from '../prompt.js';
import { loadConfig } from '../../core/config.js';
import { setSecret } from '../../storage/manager.js';
import type { DepositoryId } from '../../storage/interfaces.js';

const USAGE = 'enigma add NAME [--depository ID] [--scope project|global] [--description TEXT] [--usage interactive|unattended]';

export interface CmdAddStreams {
  stdin?: PromptStdin;
  stderr?: PromptWritable;
}

export async function cmdAdd(argv: string[], streams: CmdAddStreams = {}): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { value: ['depository', 'scope', 'description', 'usage'] });
  const [name] = positionals;
  if (!name) throw new UsageError(USAGE);

  const scope = parseScope(flags.scope) ?? 'project';
  const depository = (flags.depository as DepositoryId | undefined) ?? loadConfig().defaultDepository ?? 'encrypted';
  const description = typeof flags.description === 'string' ? flags.description : undefined;
  const usage = parseUsage(flags.usage);

  const value = await promptSecretValue(`Enter value for ${name}: `, streams);

  const result = await setSecret({
    name,
    value,
    scope,
    depository,
    cwd: process.cwd(),
    description,
    usage,
    actor: 'cli',
  });

  process.stdout.write(`Stored ${name} in ${depository} (${scope})\n`);
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  return 0;
}
