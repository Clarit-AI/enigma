---
description: Import secrets from a .env file into Enigma and rewrite the file in place. Human-initiated only — this destroys the plaintext values.
argument-hint: "[PATH] [--depository ID]"
disable-model-invocation: true
allowed-tools: mcp__plugin_enigma_enigma__enigma_import, mcp__plugin_enigma_enigma__enigma_await
---
Call the `enigma_import` MCP tool with `path` from $ARGUMENTS (default `.env` when none is given) and `depository` if one was specified.

- If a `depository` was given, this commits immediately and returns a per-name result. If not, it opens an out-of-band browser picker for the human to choose one (same pattern as `enigma_reveal`) — call `enigma_await` with the returned `request_id` if the tool result says the client doesn't support URL-mode elicitation.
- It's all-or-nothing: the source file is rewritten only if every entry succeeds. Any entry the tool can't resolve unambiguously (e.g. an unquoted value with a trailing `#`-comment-like fragment, or a duplicated name) aborts the whole batch and leaves the file untouched — it never guesses at an ambiguous value.
- Once it completes successfully, the plaintext values in the original file are gone — confirm with the user first if $ARGUMENTS looks ambiguous or the path wasn't explicit.
