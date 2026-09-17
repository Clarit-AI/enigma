---
description: List Enigma secrets known for this project and globally (names only, never values)
argument-hint: "[project|global|all]"
allowed-tools: mcp__plugin_enigma_enigma__enigma_list
---
Call the `enigma_list` MCP tool. Use `$ARGUMENTS` as the `scope` if it is exactly `project`, `global`, or `all`; otherwise use `all`. Present the resulting table to the user as-is — names, scopes, depositories, prompt profiles, and usage only, never a value.
