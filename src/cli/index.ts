import { UsageError } from './args.js';
import { cmdAdd } from './commands/add.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdGet } from './commands/get.js';
import { cmdList } from './commands/list.js';
import { cmdMove } from './commands/move.js';
import { cmdRemove } from './commands/remove.js';
import { cmdRun } from './commands/run.js';
import { notImplemented } from './commands/not-implemented.js';
import { EnigmaError } from '../core/errors.js';

const USAGE = `Usage: enigma <command> [options]

Commands:
  add NAME [--depository ID] [--scope project|global] [--description TEXT] [--usage interactive|unattended]
  list [--scope project|global|all] [--json]
  remove NAME [--scope project|global]
  move NAME --to ID [--scope project|global]
  run [--only A,B] [--scope project|global] -- <command> [args...]
  get NAME [--scope project|global]
  doctor [--json]

Not yet implemented: request, reveal, import, install
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  add: cmdAdd,
  list: cmdList,
  remove: cmdRemove,
  move: cmdMove,
  run: cmdRun,
  get: cmdGet,
  doctor: cmdDoctor,
  request: notImplemented('request'),
  reveal: notImplemented('reveal'),
  import: notImplemented('import'),
  install: notImplemented('install'),
};

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command) {
    process.stderr.write(USAGE);
    return 2;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`enigma: unknown command '${command}'\n${USAGE}`);
    return 2;
  }

  try {
    return await handler(rest);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    if (err instanceof EnigmaError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/* node:coverage disable */
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
/* node:coverage enable */
