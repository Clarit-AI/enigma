import { parseArgs, parseScope, parseUsage, UsageError } from '../args.js';
import { promptSecretValue, type PromptStdin, type PromptWritable } from '../prompt.js';
import { loadConfig } from '../../core/config.js';
import { EnigmaError } from '../../core/errors.js';
import { setSecret } from '../../storage/manager.js';
import type { DepositoryId } from '../../storage/interfaces.js';

const USAGE =
  'enigma add NAME [--depository ID] [--scope project|global] [--description TEXT] [--usage interactive|unattended] [--confirm-create-vault]';

export interface CmdAddStreams {
  stdin?: PromptStdin;
  stderr?: PromptWritable;
}

export async function cmdAdd(argv: string[], streams: CmdAddStreams = {}): Promise<number> {
  const { positionals, flags } = parseArgs(argv, {
    value: ['depository', 'scope', 'description', 'usage'],
    boolean: ['confirm-create-vault'],
  });
  const [name] = positionals;
  if (!name) throw new UsageError(USAGE);

  const scope = parseScope(flags.scope) ?? 'project';
  const depository = (flags.depository as DepositoryId | undefined) ?? loadConfig().defaultDepository ?? 'encrypted';
  const description = typeof flags.description === 'string' ? flags.description : undefined;
  const usage = parseUsage(flags.usage);
  // Never defaulted to true (Issue #28): only an explicit --confirm-create-vault authorises
  // creating a depository's backing collection (currently only 1Password's vault).
  const createVault = Boolean(flags['confirm-create-vault']);

  const value = await promptSecretValue(`Enter value for ${name}: `, streams);

  let result;
  try {
    result = await setSecret({
      name,
      value,
      scope,
      depository,
      cwd: process.cwd(),
      description,
      usage,
      actor: 'cli',
      createVault,
    });
  } catch (err) {
    if (err instanceof EnigmaError && err.code === 'E_VAULT_MISSING' && !createVault) {
      throw new EnigmaError({
        code: 'E_VAULT_MISSING',
        message: `${err.message} Pass --confirm-create-vault to enigma add to authorise creating it.`,
        secretName: name,
        depository: err.depository,
      });
    }
    throw err;
  }

  process.stdout.write(`Stored ${name} in ${depository} (${scope})\n`);
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  return 0;
}
