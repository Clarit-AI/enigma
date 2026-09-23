---
description: Delete a secret from Enigma after the user confirms. Destructive and cannot be undone — human-initiated only, never invoke this on your own judgment.
argument-hint: "NAME [project|global]"
disable-model-invocation: true
allowed-tools: mcp__plugin_enigma_enigma__enigma_remove
---
Call the `enigma_remove` MCP tool for the secret named in $ARGUMENTS.

- Parse the first token as `name` and, if a second token is present and is exactly `project` or `global`, pass it as `scope`; otherwise omit `scope`.
- If no `name` was given, ask the user which secret to remove — suggest `/enigma:list` to see what's registered. Never guess a name.
- The tool itself asks the user to confirm before removing anything; you don't need to ask separately.
- Relay the tool's result to the user as-is: it contains only a name, scope, and depository, never a value.
- If the result is `E_AMBIGUOUS_SCOPE` (the name exists in both project and global scope), ask the user which scope they mean, then call `enigma_remove` again with that `scope`.
