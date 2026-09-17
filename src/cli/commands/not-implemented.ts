/** CLI-level `request`/`reveal` are out of scope by design, not a gap awaiting implementation:
 * those flows go through the `enigma_*` MCP tools and the `/enigma:*` slash commands (Issue #14)
 * instead, and the message below says so rather than implying they are merely pending (Issue #45).
 * `import` (Issue #13) and `install` (Issue #14) each have their own implementation and no
 * longer route through this stub. */
export function notImplemented(command: string): (argv: string[]) => Promise<number> {
  return async () => {
    process.stderr.write(
      `enigma ${command} is not available at the CLI. Use \`enigma_${command}\` (MCP tool) or \`/enigma:${command}\` (slash command) instead.\n`,
    );
    return 2;
  };
}
