/** `request`, `reveal`, and `install` land in Issues #7/#14. */
export function notImplemented(command: string): (argv: string[]) => Promise<number> {
  return async () => {
    process.stderr.write(`enigma ${command}: not yet implemented\n`);
    return 2;
  };
}
