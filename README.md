# Enigma

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Enigma keeps secret values out of a coding agent's context window while it still gets to use them: request, store, run, and reveal, with no `get` path back to the model.

Status: pre-release, targeting v1. The product requirements are in [PRD.md](PRD.md); engineering context starts at [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md).

## Scope

Enigma is a development tool for one job: letting an agent *use* a secret
without the value landing in its context window. It is not a security product.

It is not an endpoint detection agent, not a defence against a compromised
machine or a hostile process running as your own user, and it does not make the
application you are building any safer. In spirit it sits closer to Infisical or
HashiCorp than to 1Password — and is deliberately far smaller than either,
because it solves a much narrower problem than they do.

The precise boundary is written down in [`docs/SECURITY.md`](docs/SECURITY.md).
What Enigma protects against is the agent reading a secret *by accident*, a
tracked value surfacing in tool output, a value leaving the plugin's own
process boundary, and the elicitation link leaking by construction. What it does
**not** protect against is deliberate evasion by the agent, same-user malware, or
anything once a value has left Enigma's boundary. If your threat is a determined
adversary rather than a well-intentioned agent having a bad day, this is the
wrong tool.

## Problem

A coding agent that needs an API key today has exactly two bad options: ask the human to paste it into the chat (now it is in the transcript, in every subsequent prompt, and in whatever logging or caching sits behind the model), or read it itself from a `.env` file or `security find-generic-password` (same outcome, one step removed). Both put the value inside the one place it can never safely leave: the model's context window. Existing secret managers (1Password, the OS keychain, `direnv`) solve secure *storage*. None of them solve the handoff into an agentic session, where the values they store still end up typed into chat or `cat`'d onto a screen the agent reads.

## Solution

Enigma's MCP server exposes tools that carry **names**, never values: `enigma_request` asks the user to enter a secret through a one-time local web form opened via MCP URL-mode elicitation (the 2025-11-25 MCP spec mandates URL mode for credentials), and the tool call that triggered it gets back only `"Stored OPENAI_API_KEY in encrypted (project)"`. The value lands in a depository the user chose (`env`, `encrypted`, macOS Keychain, Linux secret-service, or 1Password) and is retrieved only by `enigma run -- <command>`, which injects it into a child process's environment, or by `enigma_reveal`, which discloses it to the human directly and never returns it to the agent. A static check (`npm run leak-fence`) fails the build if any code under `src/mcp/**` or `src/web/**` ever calls the internal `resolve()` function that reads a plaintext value, so the invariant is enforced at build time, not just by convention.

## Proof

- **The MCP tool surface has no `get`.** Every one of the 7 tools returns text containing names, depository ids, scopes, and status only, verified by `test/security/no-value-leak.test.ts` and `test/security/leak-fence.test.ts`. See [`docs/api-contracts.md`](docs/api-contracts.md) §1.
- **Two independent enforcement layers, not one.** A `PreToolUse` read-guard denies the tool calls that would put a value into the session by accident (`Read`/`Grep`/`Glob`/`Bash` targeting a `.env` file, `security find-generic-password`, `op read`, `echo $TRACKED_NAME`, and more); a `PostToolUse` tripwire scans tool output for values Enigma already tracks and warns if one leaks through. Neither is a sandbox against deliberate evasion. See [`docs/SECURITY.md`](docs/SECURITY.md) for exactly where that line is drawn.
- **Values never touch argv, a URL, or a temp file.** Every OS integration (`security -i`, `secret-tool store`, `op item create`, `osascript`) receives the value on stdin. See the secret-handling conventions in [`docs/style-guide.md`](docs/style-guide.md).

## Quick Start

Store a key and use it, from inside a Claude Code session with the `enigma` plugin installed (see [Install](#install) below):

```text
> I need to add my OpenAI API key so I can call the API from this project.
```

Claude Code calls `enigma_request`, which opens a local form at `http://127.0.0.1:<port>/r/<id>` (or a native macOS dialog). You type the key there, once, out of band. From then on:

```bash
enigma run -- node scripts/call-openai.mjs   # injects OPENAI_API_KEY into the child only
enigma list                                  # names, scopes, depositories, never values
```

## Install

**1. Claude plugin marketplace (primary).**

```bash
claude plugin marketplace add Clarit-AI/enigma
claude plugin install enigma@clarit-enigma
```

(Or the equivalent `/plugin` menu inside an interactive Claude Code session.)

**2. GitHub checkout, for development on Enigma itself.**

```bash
git clone https://github.com/Clarit-AI/enigma.git
cd enigma && npm ci && npm run build
claude plugin marketplace add ./
claude plugin install enigma@clarit-enigma
```

This registers your checkout itself as a local marketplace source, so rebuilding `dist/` (`npm run build`) picks up changes without reinstalling.

> **npm distribution is shelved for now.** The `npx @clarit.ai/enigma install`
> method is on hold — the package has never been published, and the marketplace
> path above is the supported install method. It needs no npm registry access.
>
> Because there is no published package to run a `postinstall` from, the plugin
> puts `enigma` on your `PATH` itself: on your **first Claude Code session**
> after installing, Enigma creates one symlink in a directory that is already on
> your `PATH` and tells you so. Nothing else is touched — your shell config is
> not edited, your `PATH` is not changed, and you have nothing to run yourself.
> Run `hash -r` if the shell needs to notice.
>
> It is deliberately conservative: an existing `enigma` that already works is
> reported and left alone rather than shadowed, and only a broken symlink left
> behind by a plugin upgrade is repaired. `enigma doctor` reports the state at
> any time. To opt out entirely, set `ENIGMA_NO_PATH_SHIM=1`; if the shim cannot
> be placed at all, every command in this README still works as
> `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" <command>`.

## First request, step by step

1. **Ask.** Tell the agent what you need in plain language, "add my OpenAI key," "I need a GitHub token for this repo." The `enigma` skill (bundled with the plugin) recognizes this and calls `enigma_request` with the name(s), never asking you to paste anything into chat.
2. **Fill the form, out of band.** Claude Code opens the request URL (a local page, or a native macOS dialog if you asked for that). You pick a depository from a table showing each one's prompt profile (below) and a scope (this project, or global), type the value, and submit. The value goes straight from your browser to Enigma's local server; it is never sent back through MCP.
3. **Get a names-only confirmation.** The agent's tool call returns `"Stored OPENAI_API_KEY in encrypted (project)"`, nothing else. Nothing about the value itself ever reaches the model.
4. **Use it.** `enigma run -- <command>` injects the real value into that one child process's environment. The agent sees the child's stdout/stderr, never the injected variable. (`enigma` is on your `PATH` from your first session — see [Install](#install). If it isn't, run `enigma doctor` to see why.)

### Slash commands

The plugin ships six: `/enigma:request`, `/enigma:reveal`, `/enigma:list`,
`/enigma:remove`, `/enigma:doctor` and `/enigma:import`.

Three are **user-only** (`disable-model-invocation`) — the agent may not invoke
them on its own judgment: `reveal` and `import`, because both are the human
taking the value or handing data over, and `remove`, because deleting a secret
is destructive and cannot be undone. The remaining three — `request`, `list`
and `doctor` — are model-invokable.

`/enigma:remove NAME [project|global]` wraps the `enigma_remove` MCP tool. How
the confirmation works depends on your client: a form-capable one shows its own
yes/no dialog, and the agent never sees that path. A client without form-mode
elicitation gets `E_CONFIRMATION_REQUIRED` instead, and the agent must ask you
to confirm in conversation before re-calling with `confirm: true` — invoking the
slash command is not itself a confirmation. If you omit the scope argument and
the name exists in *both* project and global scope, the tool returns
`E_AMBIGUOUS_SCOPE` and the agent asks which you meant rather than guessing;
naming the scope explicitly always resolves.

### Depositories and prompt profiles

The **prompt profile** is what a depository costs you on every *read*. This is the tradeoff the picker in step 2 surfaces, and it is worth choosing deliberately for anything that will run unattended (a prompt-profile depository other than `none` will hang a cron job the first time nothing is there to answer it).

| Depository | Prompt profile | What that means |
|---|---|---|
| `env` | `none` | Project `.env` file, in a managed block. No prompt; same trust level as any other file on disk. |
| `encrypted` | `none` | Enigma's own AES-256-GCM store (`~/.config/enigma/secrets.enc`); key lives locally. No prompt. |
| `keychain` (macOS) | `may-prompt` | May trigger a Touch ID / password prompt on read, depending on OS-level access rules. |
| `secret-service` (Linux) | `may-prompt` | Same idea, via the desktop secret-service D-Bus API. |
| `1password` | `prompts-each-read` | Prompts (biometric or 1Password unlock) on every single read, no exceptions. Never use for anything unattended. |

(Source of truth: `promptProfile` in each `src/storage/depositories/*.ts` module. This table is generated by reading them, not copied from another document.)

## What the hooks do

Enigma installs three Claude Code hooks (`plugins/enigma/hooks/hooks.json`), all bundled into one file (`dist/hooks.mjs`) dispatched by event name:

- **`SessionStart`** injects the *names* of secrets Enigma knows about into context, so the agent can say "I see you have `OPENAI_API_KEY` stored" without ever seeing its value.
- **`PreToolUse`** (the read-guard) denies a `Read`, `Grep`, `Glob`, or `Bash` call that would read a `.env` file, Enigma's config directory, the Keychain, or a 1Password item directly, and tells the agent what to call instead. It normalizes `${IFS}` word-splitting and `$'...'` ANSI-C quoting before matching, since those are the cheapest ways to dodge a plain-text pattern.
- **`PostToolUse`** (the tripwire) scans a tool's output for the plaintext of any secret Enigma tracks and warns with `LEAK: value of NAME appeared in tool output` if one shows up. It can only warn, not redact, because Claude Code has no output-rewrite hook.

Both `PreToolUse` and `PostToolUse` are heuristics, not a sandbox. Read [`docs/SECURITY.md`](docs/SECURITY.md) for precisely what they do and don't stop.

## FAQ

**Why is my `enigma` command suddenly a symlink?** Because a marketplace install has no `postinstall` to run, so the plugin creates one link in a directory already on your `PATH` during your first session after installing. It refuses to replace an `enigma` that already works, repairs only a broken one left by a plugin upgrade, and never edits your shell config. `enigma doctor` shows the current state; `ENIGMA_NO_PATH_SHIM=1` turns it off. See [Install](#install).

**Does the agent ever see my secret's value?** On any path Enigma controls, no: no MCP tool result carries one, and `npm run leak-fence` fails the build if the storage layer's `resolve()` function is ever reachable from `src/mcp/**` or `src/web/**`. That is a statement about Enigma's own code, not a promise about the agent's behaviour — an agent that deliberately goes looking for a value in its own environment is out of scope by design. See [Scope](#scope) and [`docs/SECURITY.md`](docs/SECURITY.md).

**What if I want to see the value myself?** Call `enigma_reveal` (or `/enigma:reveal NAME`). It opens a one-time page or copies to your clipboard, and it is human-initiated only; the agent shouldn't invoke it on its own judgment.

**Can I use this for CI or a cron job?** Yes. Pick a `none`-prompt-profile depository (`env` or `encrypted`) and pass `usage: "unattended"` to `enigma_request` when you store the value. A `may-prompt` or `prompts-each-read` depository will hang the job.

**What happens if I read a `.env` file by accident?** The read-guard denies it before the content ever reaches the session, and tells you (or the agent) to use `enigma_request` or `enigma run` instead.

**Does remote access mean anyone with the link can see my secret?** The request/reveal link carries only a random, single-use, time-limited id, and a `cloudflared`/`tailscale serve` tunnel's lifetime is tied to that one request. It is still a bearer link with no PIN in v1. See the tunnel-interception section of [`docs/SECURITY.md`](docs/SECURITY.md) for the exact boundary.

**Why not just use 1Password/the Keychain directly?** You can, and Enigma stores into them rather than replacing them (`1password` and `keychain` are two of the five depositories). What Enigma adds is the handoff: getting a value from that store into a running command without an agent (or you) ever typing it into a chat window.

## Ecosystem Context

Enigma is part of the Clarit.AI open-source ecosystem. Enigma focuses on keeping secret values out of an agent's context during a coding session, while Engram focuses on persistent memory for AI conversations and Synapse focuses on hybrid NPU/CPU inference routing on edge hardware.

## Contributing

Issues and PRs are welcome. Read [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) first. It indexes the architecture decisions (`docs/architecture.md`), API contracts (`docs/api-contracts.md`), and style guide (`docs/style-guide.md`) that every change is expected to follow. Every PR adds or updates tests for its Issue's acceptance criteria and keeps `docs/api-contracts.md` in sync with any interface it touches.

## License and Acknowledgements

Apache-2.0. See [LICENSE](LICENSE). Enigma's request/reveal store, network-policy, Linux secret-service pattern, and static leak-fence design are harvested from ClawVault, not forked (see ADR-007 in [`docs/architecture.md`](docs/architecture.md) for exactly what was kept and what wasn't).
