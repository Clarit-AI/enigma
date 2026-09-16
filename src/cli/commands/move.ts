import { parseArgs, parseScope, UsageError } from '../args.js';
import { resolveSecret, setSecret } from '../../storage/manager.js';
import { readIndex, resolveIndexEntry } from '../../core/index-store.js';
import { projectId as computeProjectId } from '../../core/project.js';
import { DEPOSITORY_MODULES } from '../../storage/detect.js';
import { EnigmaError } from '../../core/errors.js';
import type { DepositoryId } from '../../storage/interfaces.js';

const USAGE = 'enigma move NAME --to ID [--scope project|global]';

export async function cmdMove(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { value: ['to', 'scope'] });
  const [name] = positionals;
  const to = flags.to;
  if (!name || typeof to !== 'string') throw new UsageError(USAGE);
  const target = to as DepositoryId;

  const scopeFlag = parseScope(flags.scope);
  const cwd = process.cwd();
  const pid = computeProjectId(cwd);
  const entry = resolveIndexEntry(readIndex(), name, scopeFlag, pid);
  if (!entry) {
    throw new EnigmaError({ code: 'E_NOT_FOUND', message: `${name} not found`, secretName: name });
  }

  if (entry.depository === target) {
    process.stdout.write(`${name} is already in ${target}\n`);
    return 0;
  }

  const value = await resolveSecret(name, { scope: entry.scope, cwd, actor: 'cli' });
  await setSecret({
    name,
    value,
    scope: entry.scope,
    depository: target,
    cwd,
    description: entry.description,
    usage: entry.usage,
    rotate: true,
    actor: 'cli',
  });

  // Best-effort cleanup of the old value; the index already points at the new depository.
  const oldModule = DEPOSITORY_MODULES.find((m) => m.id === entry.depository);
  if (oldModule) {
    const projectPath = entry.scope === 'project' ? entry.projectPath : undefined;
    await oldModule.create({ projectPath }).delete(entry.ref).catch(() => undefined);
  }

  process.stdout.write(`Moved ${name} to ${target} (${entry.scope})\n`);
  return 0;
}
