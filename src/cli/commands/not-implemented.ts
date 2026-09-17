/** CLI-level `request`/`reveal` are out of scope: those flows go through the `enigma_*` MCP
 * tools and the `/enigma:*` slash commands (Issue #14) instead. `import` (Issue #13) and
 * `install` (Issue #14) each have their own implementation and no longer route through this stub. */
export function notImplemented(command: string): (argv: string[]) => Promise<number> {
  return async () => {
    process.stderr.write(`enigma ${command}: not yet implemented\n`);
    return 2;
  };
}
