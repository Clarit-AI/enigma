import { UsageError } from './args.js';
import { cmdAdd } from './commands/add.js';
import { cmdDoctor } from './commands/doctor.js';
import { cmdGet } from './commands/get.js';
import { cmdImport } from './commands/import.js';
import { cmdInstall } from './commands/install.js';
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
  import [PATH] [--depository ID] [--rotate] [--json]
  doctor [--json]
  install [--uninstall]

Not available at the CLI: request, reveal
  (use the enigma_request/enigma_reveal MCP tools, or /enigma:request and /enigma:reveal)
`;

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  add: cmdAdd,
  list: cmdList,
  remove: cmdRemove,
  move: cmdMove,
  run: cmdRun,
  get: cmdGet,
  doctor: cmdDoctor,
  import: cmdImport,
  install: cmdInstall,
  request: notImplemented('request'),
  reveal: notImplemented('reveal'),
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
      // Errors with an explicit exitCode (e.g. E_BINARY_MISSING → 127, the shell
      // convention for "command not found", Issue #22 AC #1) win over the default
      // 1; the code is printed first so a script parsing stderr can match it.
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return err.exitCode ?? 1;
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
