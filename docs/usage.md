# Using Enigma

Everything here assumes the plugin is installed (see [install.md](install.md)). For the exact tool schemas, routes and file formats, see [`api-contracts.md`](api-contracts.md).

## First request, step by step

1. **Ask.** Tell the agent what you need in plain language, "add my OpenAI key," "I need a GitHub token for this repo." The `enigma` skill (bundled with the plugin) recognizes this and calls `enigma_request` with the name(s), never asking you to paste anything into chat.
2. **Fill the form, out of band.** Claude Code opens the request URL (a local page, or a native dialog if you asked for one; native dialogs are macOS-only). If your client doesn't support URL-mode elicitation, or declines, cancels or doesn't answer within 30 seconds, the agent gets the local link instead. It asks you to open it, then calls `enigma_await` to collect the names-only result. You pick a depository from a table showing each one's prompt profile (see [depositories.md](depositories.md)) and a scope (this project, or global), type the value, and submit. The value goes straight from your browser to Enigma's local server; it is never sent back through MCP.
3. **Get a names-only confirmation.** The agent's tool call returns `"Stored OPENAI_API_KEY in encrypted (project)"`, nothing else. Nothing about the value itself ever reaches the model.
4. **Use it.** `enigma run -- <command>` injects the real value into that one child process's environment. The agent sees the child's stdout/stderr, never the injected variable. (`enigma` is on your `PATH` from your first session, see [install.md](install.md). If it isn't, run `enigma doctor` to see why.)

## Answering a request from your phone

Remote access is opt-in per `enigma_request` call. The agent passes `remote`: `true` asks for a tunnel (or an honest refusal if none is available), `"prefer"` tries a tunnel and falls back to the local link. Enigma starts a `cloudflared` quick tunnel by default, or `tailscale serve` if `~/.config/enigma/config.json` sets `"remote": "tailscale"`. The local request page shows a QR code of the public URL so you can open it on your phone.

The link carries only a random, single-use, time-limited id, and the tunnel's lifetime is tied to that one request. It is still a bearer link with no PIN in v1; the exact boundary, including what a `cloudflared` link and a `tailscale serve` link each expose, is in the tunnel-interception section of [`SECURITY.md`](SECURITY.md). `/enigma:doctor` reports whether the tunnel binaries are present.

## Slash commands

The plugin ships six: `/enigma:request`, `/enigma:reveal`, `/enigma:list`,
`/enigma:remove`, `/enigma:doctor` and `/enigma:import`.

Three are **user-only** (`disable-model-invocation`), so the agent may not invoke
them on its own judgment: `reveal` and `import`, because both are the human
taking the value or handing data over, and `remove`, because deleting a secret
is destructive and cannot be undone. The remaining three, `request`, `list`
and `doctor`, are model-invokable.

`/enigma:remove NAME [project|global]` wraps the `enigma_remove` MCP tool. How
the confirmation works depends on your client: a form-capable one shows its own
yes/no dialog, and the agent never sees that path. A client without form-mode
elicitation gets `E_CONFIRMATION_REQUIRED` instead, and the agent must ask you
to confirm in conversation before re-calling with `confirm: true`. Invoking the
slash command is not itself a confirmation. If you omit the scope argument and
the name exists in *both* project and global scope, the tool returns
`E_AMBIGUOUS_SCOPE` and the agent asks which you meant rather than guessing;
naming the scope explicitly always resolves.

`/enigma:doctor` calls the `enigma_doctor` MCP tool. Besides what `enigma doctor` prints, it also lists any submitted request whose result never reached the agent, with the `enigma_await` call to collect it.

## CLI reference

| Command | What it does |
|---|---|
| `enigma add NAME [--depository ID] [--scope project\|global] [--description TEXT] [--usage interactive\|unattended] [--confirm-create-vault]` | Store a value you type at a hidden terminal prompt. `--confirm-create-vault` is the explicit, one-time consent to create a depository's backing collection when it doesn't exist yet (today, only 1Password's `Enigma` vault). |
| `enigma list [--scope project\|global\|all] [--json]` | Names, scopes and depositories. Never values. |
| `enigma remove NAME [--scope project\|global]` | Delete a secret. |
| `enigma move NAME --to ID [--scope project\|global]` | Move a secret to another depository. |
| `enigma run [--only A,B] [--scope project\|global] -- <command>` | Inject secrets into one child process's environment. |
| `enigma get NAME [--scope project\|global]` | Print one value to stdout, with a warning. For humans and scripts only; the read-guard blocks the agent from running it. Prefer `enigma run`. |
| `enigma import [PATH] [--depository ID] [--rotate] [--json]` | Import an existing `.env` file. |
| `enigma render [NAME] [--json]` | Write project secrets into the worktree's `.env` render block (see [render.md](render.md)). |
| `enigma migrate-scope [--from PATH] [--apply] [--prune-unrecoverable]` | Re-key project-scope entries recorded before the repository-level project id (index only; never reads a value). Dry run unless you pass `--apply`. |
| `enigma doctor [--json]` | Platform, depositories, PATH link, missing manifest names. |
| `enigma install [--uninstall]` | Register the marketplace and install (or uninstall) the Claude Code plugin. |

`request` and `reveal` are deliberately not CLI commands. Use the MCP tools or the `/enigma:request` and `/enigma:reveal` slash commands. Run `enigma` with no arguments to print its own usage string; if it ever disagrees with this table, the CLI is correct.

## Using Enigma for CI or a cron job

Pick a `none`-prompt-profile depository (`env` or `encrypted`) and pass `usage: "unattended"` to `enigma_request` when you store the value. A `may-prompt` or `prompts-each-read` depository will hang the job. See [depositories.md](depositories.md).
