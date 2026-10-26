# What the hooks do

Enigma installs three Claude Code hooks (`plugins/enigma/hooks/hooks.json`), all bundled into one file (`dist/hooks.mjs`) dispatched by event name:

- **`SessionStart`** injects the *names* of secrets Enigma knows about into context, so the agent can say "I see you have `OPENAI_API_KEY` stored" without ever seeing its value. It also reports a sticky default depository if one is set, names that `.enigma.json` declares but that aren't stored, this repository's legacy project-scope entries that need `enigma migrate-scope`, and the state of the `enigma` PATH link when there is something to report.
- **`PreToolUse`** (the read-guard) denies a `Read`, `Grep`, `Glob`, or `Bash` call that would read a `.env` file, Enigma's config directory, the Keychain, or a 1Password item directly, and tells the agent what to call instead. It normalizes `${IFS}` word-splitting and `$'...'` ANSI-C quoting before matching, since those are the cheapest ways to dodge a plain-text pattern.
- **`PostToolUse`** (the tripwire) scans a tool's output for the plaintext of any secret Enigma tracks and warns with `LEAK: value of NAME appeared in tool output` if one shows up. It can only warn, not redact, because Claude Code has no output-rewrite hook.

Both `PreToolUse` and `PostToolUse` are heuristics, not a sandbox. Read [`SECURITY.md`](SECURITY.md) for precisely what they do and don't stop.
