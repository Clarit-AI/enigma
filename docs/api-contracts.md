# API Contracts

Workers implement against this document. Changing an interface means changing this file in the same PR.

## 1. MCP tools (server name `enigma`; installed as `mcp__plugin_enigma_enigma__<tool>`)

Every tool result is text and contains names, depository ids, scopes, and status only. No tool has a value in its result, ever.

| Tool | Input (zod) | Result |
|---|---|---|
| `enigma_list` | `{ scope?: "project"\|"global"\|"all" }` | table of `{ name, scope, depository, promptProfile, usage, updatedAt, shadowed }` |
| `enigma_request` | `{ names: string[] (1..10), reason: string, usage: "interactive"\|"unattended", depository?: DepositoryId, scope?: "project"\|"global", rotate?: boolean, ui?: "web"\|"native", remote?: boolean, confirmCreateVault?: boolean }` | with elicitation: blocks, then `"Stored NAME in <depository> (<scope>)"` per name; without: `{ request_id, url, expiresAt }` plus instruction to call `enigma_await` |
| `enigma_await` | `{ request_id: string }` | same success text as above, or `E_REQUEST_EXPIRED` |
| `enigma_reveal` | `{ name: string, scope?: …, method?: "page"\|"clipboard" }` | `"Reveal link opened; expires in 5 min"` or `"Copied to clipboard; clears in 60 s"` |
| `enigma_remove` | `{ name: string, scope?: … }` | form-mode boolean confirmation, then `"Removed NAME from <depository>"`; `E_AMBIGUOUS_SCOPE` when both scopes hold the name and none was given |
| `enigma_import` | `{ path?: string (default ".env"), depository?: DepositoryId, rotate?: boolean }` | names imported, file rewritten summary |
| `enigma_doctor` | `{}` | platform, available depositories with prompt profiles, `op` status, tunnel binaries, manifest gaps, config paths |

`DepositoryId = "env" | "encrypted" | "keychain" | "secret-service" | "1password"`.

Errors: `isError: true`, text `E_CODE: message` (no values). `E_EXISTS` when `rotate` is not set for an existing name. `E_OUTCOME_UNKNOWN` (Issue #69 AC #5): `enigma_await`, blocking `enigma_request`, and URL-mode `enigma_import` could not determine whether the declared names were stored — the single-use token was consumed (the human submitted the form) but `fulfill` never ran before the used-record grace period elapsed; the message names the declared names and tells the agent to run `enigma list` to verify, never carries a value. `E_REQUEST_EXPIRED` stays reserved for a record that was never used in the first place.

`confirmCreateVault` (Issue #28) is the explicit, one-time user confirmation to create a depository's backing collection when it doesn't exist yet — currently only 1Password's `Enigma` vault. It is never defaulted to true anywhere. `enigma_request`'s `ui:"native"` path consumes it directly: an unconfirmed `E_VAULT_MISSING` is asked about via form-mode elicitation (a yes/no confirmation is not a credential, so form mode is permitted here — same reasoning as `enigma_remove`'s confirmation) before falling back to a client without form-elicitation support. The URL-mode path doesn't need the field itself — its actual write happens on the human's web form (`POST /r/:id`, §2), which asks for the same confirmation there. `enigma add` (§3) exposes the identical confirmation as `--confirm-create-vault`.

## 2. Local HTTP server (`127.0.0.1:<ephemeral>`)

| Route | Purpose | Notes |
|---|---|---|
| `GET /r/:id` | request form | 404 unknown/expired, 410 used |
| `POST /r/:id` | submit values | body `application/x-www-form-urlencoded` or JSON: `{ values: { NAME: string }, depository, scope }`; atomic single-use; 200 done page; 410 on replay; 413 over 64 KB |
| `GET /r/:id/status` | cheap state-only poll for host background-watch tools (Issue #69 §1) | 200 `{"state":"pending"}` while the human hasn't submitted, `{"state":"fulfilled"}` once results are recorded; 404 unknown/expired/swept or when the id is not `kind === 'request'` (so the route never confirms other kinds exist); no names, no values, never calls `consumeOutcome` |
| `GET /v/:id` | reveal page shell (no value) | 404/410 as above |
| `POST /v/:id/reveal` | returns the value once, burns the id | JSON `{ name, value }`; only route that ever carries a value; never logged |
| `GET /static/*` | css/js | CSP `script-src 'self'` |
| `GET /healthz` | liveness | `{ ok: true }` |

Headers on every response: `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

## 3. CLI (`enigma`)

This block mirrors `enigma`'s own `USAGE` string in `src/cli/index.ts` (run `enigma` with no arguments to see it). If the two ever disagree, the CLI is correct and this file is stale.

```
enigma add NAME [--depository ID] [--scope project|global] [--description TEXT] [--usage interactive|unattended] [--confirm-create-vault]
enigma list [--scope …] [--json]
enigma remove NAME [--scope …]
enigma move NAME --to ID [--scope …]
enigma run [--only A,B] [--scope …] -- <command> [args...]
enigma get NAME [--scope …]        # humans/scripts; stderr warning; blocked for the agent by the read-guard
enigma import [PATH] [--depository ID] [--rotate] [--json]
enigma doctor [--json]
enigma install [--uninstall]       # register marketplace + enable plugin
```

`enigma request` and `enigma reveal` are **not available at the CLI, by design**: `src/cli/index.ts` routes both names to a stub (`src/cli/commands/not-implemented.ts`) that prints `enigma <command> is not available at the CLI. Use \`enigma_<command>\` (MCP tool) or \`/enigma:<command>\` (slash command) instead.` and exits 2. That flow exists today only as the `enigma_request`/`enigma_reveal` MCP tools (§1) and the `/enigma:*` slash commands (Issue #14) — the stub's own header comment confirms this is a deliberate scope boundary, not a gap waiting to be filled, so this document does not carry them as CLI commands until a future decision reverses that.

Exit codes: 0 ok, 1 Enigma error (code printed), 2 usage (also returned by the `request`/`reveal` stub), **127 `E_BINARY_MISSING`** — `enigma run <binary>` could not spawn the child because the binary does not exist on `PATH` (Issue #22, AC #1; shell convention for "command not found"); the printed message names the binary, never a value. `run` otherwise exits with the child's code: the raw exit code for a normal exit, or `128 + signum` when the child is killed by a signal (POSIX shell convention).

Boolean flags accept an explicit `--flag=true|false|yes|no|0|1` form too (case-insensitive) — `--json=false` is honored, not silently coerced to `true` (Issue #22, AC #4); any other value is a usage error (exit 2). A value flag followed by a token starting with `--` is a usage error rather than silently consuming the next flag (Issue #22, AC #3). `enigma run` refuses any positional before `--` (e.g. `enigma run foo -- cmd`) with a usage error (Issue #22, AC #2).

## 4. File formats

`~/.config/enigma/index.json` (0600):
```json
{ "version": 1, "entries": [ { "name": "OPENAI_API_KEY", "scope": "project", "projectId": "9f3a…", "projectPath": "/abs/path", "depository": "keychain", "ref": "9f3a…/OPENAI_API_KEY", "description": "…", "usage": "interactive", "createdAt": "ISO", "updatedAt": "ISO" } ] }
```

`~/.config/enigma/audit.log` (0600, JSONL):
```json
{ "ts": "ISO", "op": "set|rotated|read|reveal|remove|move|import|leak", "name": "…", "scope": "…", "depository": "…", "actor": "agent|user|cli|hook", "ok": true, "error": null, "method"?: "clipboard"|"page" }
```
`method` (Issue #26) is present only on a `reveal` line, naming the disclosure surface — never a value, ref, or anything derived from the secret. It's optional so every audit line written before this field existed stays valid; a reader encountering a `reveal` line without it should treat the method as "not recorded", never assume a specific one. The union only ever names a surface a reveal path actually produces — `enigma_reveal`'s own method is `page | clipboard` — so a new member is added only alongside the reveal path that emits it, never speculatively.

Corrupt/unparsable on-disk JSON never surfaces a raw `SyntaxError` (Issue #18): `index.json` → `E_INDEX_CORRUPT`, `secrets.enc` → `E_VAULT_CORRUPT` (naming depository `encrypted`), `config.json` and project `.enigma.json` → `E_CONFIG_CORRUPT`. Every case names the file's path and says to fix or remove it by hand; none ever include the file's actual bytes.

`~/.config/enigma/secrets.enc` (0600): `{ "version": 1, "entries": { "<ref>": { "iv": b64, "tag": b64, "ct": b64 } } }`; key at `~/.config/enigma/enigma.key` (0600, 32 random bytes, base64).

`~/.config/enigma/config.json`: `{ "defaultDepository"?: ID, "remote"?: "cloudflared"|"tailscale", "tripwire"?: { "depositories": ID[] }, "ui"?: "web"|"native" }`.

Project `.enigma.json` (committed): `{ "defaultDepository"?: ID, "secrets": { "NAME": "description" } }`.

Project `.env` managed block:
```
# enigma:begin
NAME=value
# enigma:end
```
Each `NAME` line is one dotenv-compatible entry, `ref` is the bare `NAME` (no scope prefix — the file is already scoped by `projectPath`). A value is written bare when it contains none of whitespace, `#`, `"`, `'`, `\`, or `$`; otherwise it is written double-quoted with `\`→`\\`, `"`→`\"`, CR→`\r`, and LF→`\n` (so a multi-line value, e.g. a PEM key, is stored as a single quoted line and a value that happens to contain the literal text `# enigma:end` can never be mistaken for the block terminator). Reading the block applies the exact inverse. This matches Node's built-in `util.parseEnv` for the common case (values whose only escape is an embedded newline); values containing a literal backslash or double quote round-trip correctly only through Enigma's own reader.

**Depository limits**: the `keychain` depository's `set` computes, before spawning anything, the plaintext value byte length that still fits `security -i`'s 4096-byte batch-line budget once the fixed command overhead and the given `ref` are subtracted; a value over that ceiling is rejected with `E_VALUE_TOO_LARGE` (the ceiling and a recommendation to use the `encrypted` depository for large material such as PEM keys are in the message; the value itself never is). `keychain` and `secret-service` both reject a `ref` containing characters outside `[A-Za-z0-9_./-]`, or longer than 512 characters, with `E_REF_INVALID`, checked at the depository boundary before any process is spawned. `E_WRITE_FAILED` reports a failed `set`, distinct from `E_READ_FAILED` for a failed `resolve`/`delete`.

## 5. Hook contracts (`dist/hooks.mjs <event>`)

- `SessionStart`: stdout JSON `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "<names only>" } }`.
- `PreToolUse`: on a deny, stdout `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "…use enigma_request / enigma run…" } }`, exit 0; when a safe rewrite can be expressed instead of an outright deny (e.g. adding a `.env*` glob exclusion to a recursive `Grep` so it can't walk into a secret file), stdout `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "…", updatedInput: { …tool's own input, with the fix applied… } } }`, exit 0; otherwise exit 0 with no output.
- `PostToolUse`: on a hit, stdout `{ systemMessage: "LEAK: value of NAME appeared in tool output; rotate it via enigma_request rotate:true" }` (one such line per matched name); always exit 0; 5-s self-timeout; outputs > 1 MB skipped; a candidate value under 6 characters is never compared (a short substring produces far more false positives than true positives — a heuristic, not a security boundary).

**What these two guarantee, and what they don't** (state this accurately wherever either is described — a control that overstates itself is worse than one that states its limits; if this paragraph and `src/hooks/read-guard.ts`'s own header comment ever disagree, the code comment is correct and this paragraph is stale): the read-guard stops an agent from reading a secret *by accident* (grepping the repo, catting a `.env`, echoing a tracked name); shell word-splitting (`${IFS}`) and ANSI-C quoting (`$'...'`) are normalized before matching, since they're the cheapest and most common ways to dodge a plain-text match, but neither the read-guard nor the tripwire is a sandbox, and neither stops an agent deliberately evading them (variable indirection, an assembled `eval`, writing and running a script, or reading through an interpreter). An encode/decode round-trip is **not** among those gaps: `base64 .env`, `xxd .env`, and `cp .env x` are all still denied, because the guard matches on the `.env` argument itself rather than on which command reads it, and `cp`/`base64`/`tar` are deliberately absent from the small allowlist of non-reading verbs (`mv`, `rm`, `touch`, and similar) that are exempted. A `source`/`.`-style load of `.env` into the current shell is denied outright by the read-guard specifically because, once past it, it surfaces in **neither** layer — the tripwire only ever sees a value that's actually printed somewhere in tool output. The `${IFS}` normalization has no quote tracking and runs over the whole command regardless of single/double quotes, so it can also deny a single-quoted literal that merely looks like a `.env` reference once collapsed (e.g. `echo '${IFS}.env'`) even though bash itself would never expand `${IFS}` there — an accepted, narrow false positive (denial, never a bypass), not a bug to be "fixed" with real quote parsing.
