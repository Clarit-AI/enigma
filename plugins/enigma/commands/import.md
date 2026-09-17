---
description: Import secrets from a .env file into Enigma and rewrite the file in place. Human-initiated only — this destroys the plaintext values.
argument-hint: "[PATH] [--depository ID]"
disable-model-invocation: true
allowed-tools: mcp__plugin_enigma_enigma__enigma_import, mcp__plugin_enigma_enigma__enigma_await
---
Call the `enigma_import` MCP tool with `path` from $ARGUMENTS (default `.env` when none is given) and `depository` if one was specified.

- If a `depository` was given, this commits immediately and returns a per-name result. If not, it opens an out-of-band browser picker for the human to choose one (same pattern as `enigma_reveal`) — call `enigma_await` with the returned `request_id` if the tool result says the client doesn't support URL-mode elicitation.
- It processes names in order and stops at the first one it can't store — an entry it can't resolve unambiguously (e.g. an unquoted value with a trailing `#`-comment-like fragment, or a duplicated name) is refused rather than guessed at, and that refusal aborts the rest of the batch.
- **The file rewrite is all-or-nothing; storage is not.** Any name that already succeeded before the abort is durably stored in its depository regardless of which depository was chosen — a batch failure does not undo it. What's all-or-nothing is only the source file's own rewrite: it is left completely untouched unless every entry in the batch succeeds, so the plaintext lines for already-stored names remain in the file too (now duplicated: once in the depository, once as the original line). The `env` depository is the one case where this is unmissable, since its own writes land in a managed block inside that same file — surfaced with an explicit warning — but the same "already stored, original line still there" outcome holds for every other depository too, just without that extra warning. Don't assume a failed import means nothing was stored: check the per-name result.
