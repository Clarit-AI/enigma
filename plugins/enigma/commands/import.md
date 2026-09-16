---
description: Import secrets from a .env file into Enigma and rewrite the file in place. Human-initiated only — this destroys the plaintext values.
argument-hint: "[PATH] [--depository ID]"
disable-model-invocation: true
allowed-tools: mcp__plugin_enigma_enigma__enigma_import
---
Call the `enigma_import` MCP tool with `path` from $ARGUMENTS (default `.env` when none is given) and `depository` if one was specified.

This moves each value out of the plaintext file into the chosen depository and rewrites the file's managed block in place — the plaintext values in the original file are gone once it completes, so confirm with the user first if $ARGUMENTS looks ambiguous or the path wasn't explicit.
