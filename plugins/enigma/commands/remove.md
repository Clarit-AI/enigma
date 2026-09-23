---
description: Delete a secret from Enigma after the user confirms. Destructive and cannot be undone — human-initiated only, never invoke this on your own judgment.
argument-hint: "NAME [project|global]"
disable-model-invocation: true
allowed-tools: mcp__plugin_enigma_enigma__enigma_remove
---
Split $ARGUMENTS on whitespace and validate it fully before calling anything — never guess or silently drop a bad token.

- Zero tokens: ask the user which secret to remove — suggest `/enigma:list` to see what's registered. Never guess a name. Do not call the tool.
- One token: that's `name`. Call `enigma_remove` with `name` only — omit `scope`.
- Two tokens and the second is exactly `project` or `global`: that's `name` and `scope`. Call `enigma_remove` with both.
- Any other shape — a second token that isn't exactly `project` or `global`, or more than two tokens — is invalid input. Do not call the tool. Tell the user the second argument must be exactly `project` or `global`, state what you understood as `name`, and ask them to re-run with a corrected scope or no scope at all.

Handle the tool's result, retrying only as described below and never on your own initiative otherwise:

- `E_CONFIRMATION_REQUIRED` (a client without form-mode elicitation support): ask the user to explicitly confirm deleting `name` (and `scope`, once you know it) — say plainly this cannot be undone. The slash command being invoked is not itself that confirmation. Only call `enigma_remove` again, adding `confirm: true`, after an affirmative reply; if the user declines or doesn't answer, stop and make no further call. A form-capable client instead handles this confirmation itself through its own elicitation dialog — you won't see this code there, and must not ask a second time on top of it.
- `E_AMBIGUOUS_SCOPE` (the name exists in both project and global scope, and none was given): ask the user which scope they mean, then call `enigma_remove` again with that `scope` — carry forward `confirm: true` if you already obtained it.
- Any other result — success or another error code: relay the tool's text to the user verbatim. It contains only names, status, and depository, never a value.
