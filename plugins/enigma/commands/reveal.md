---
description: Reveal one secret's value to the user, out of band. Human-initiated only — never invoke this on your own judgment.
argument-hint: "NAME [--clipboard]"
disable-model-invocation: true
allowed-tools: mcp__plugin_enigma_enigma__enigma_reveal
---
Call the `enigma_reveal` MCP tool for the secret named in $ARGUMENTS. Use `method: "clipboard"` only if `--clipboard` was given (macOS only); otherwise use the default one-time page reveal.

This discloses the value to the human only — it never returns to you, and you must never ask the user to paste it back into this session.
