---
description: Ask the user to enter one or more secrets out of band via Enigma
argument-hint: "NAME [NAME...] [reason]"
allowed-tools: mcp__plugin_enigma_enigma__enigma_request, mcp__plugin_enigma_enigma__enigma_await
---
Call the `enigma_request` MCP tool to collect the secret(s) named in $ARGUMENTS from the user out of band.

- Treat the leading `SCREAMING_SNAKE_CASE`-looking tokens as `names`; treat any remaining words as the `reason`. If no reason was given, ask the user in one line, or infer a short one from the current task.
- Set `usage: "unattended"` only if the user says this will run later with no one watching (a background job, CI, a cron task); otherwise use `"interactive"`.
- Do not pick a `depository` yourself unless the user has already told you which one they want — see the `enigma` skill for why that choice depends on the `usage` above.
- If the result includes a `request_id` and a link (the client could not show the form itself), the user cannot see that link until you send it: put it in your reply, end your turn, and call `enigma_await` with the `request_id` only after the user says they've submitted the form. Never call `enigma_await` in the same turn as `enigma_request`.
- The tool never returns a value — never repeat one back, and never ask the user to paste one here instead.
