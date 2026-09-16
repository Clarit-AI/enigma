# API Contracts

Workers implement against this document. Changing an interface means changing this file in the same PR.

## 1. MCP tools (server name `enigma`; installed as `mcp__plugin_enigma_enigma__<tool>`)

Every tool result is text and contains names, depository ids, scopes, and status only. No tool has a value in its result, ever.

| Tool | Input (zod) | Result |
|---|---|---|
| `enigma_list` | `{ scope?: "project"\|"global"\|"all" }` | table of `{ name, scope, depository, promptProfile, usage, updatedAt, shadowed }` |
| `enigma_request` | `{ names: string[] (1..10), reason: string, usage: "interactive"\|"unattended", depository?: DepositoryId, scope?: "project"\|"global", rotate?: boolean, ui?: "web"\|"native", remote?: boolean }` | with elicitation: blocks, then `"Stored NAME in <depository> (<scope>)"` per name; without: `{ request_id, url, expiresAt }` plus instruction to call `enigma_await` |
| `enigma_await` | `{ request_id: string }` | same success text as above, or `E_REQUEST_EXPIRED` |
| `enigma_reveal` | `{ name: string, scope?: …, method?: "page"\|"clipboard" }` | `"Reveal link opened; expires in 5 min"` or `"Copied to clipboard; clears in 60 s"` |
| `enigma_remove` | `{ name: string, scope?: … }` | form-mode boolean confirmation, then `"Removed NAME from <depository>"`; `E_AMBIGUOUS_SCOPE` when both scopes hold the name and none was given |
| `enigma_import` | `{ path?: string (default ".env"), depository?: DepositoryId }` | names imported, file rewritten summary |
| `enigma_doctor` | `{}` | platform, available depositories with prompt profiles, `op` status, tunnel binaries, manifest gaps, config paths |

`DepositoryId = "env" | "encrypted" | "keychain" | "secret-service" | "1password"`.

Errors: `isError: true`, text `E_CODE: message` (no values). `E_EXISTS` when `rotate` is not set for an existing name.

## 2. Local HTTP server (`127.0.0.1:<ephemeral>`)

| Route | Purpose | Notes |
|---|---|---|
| `GET /r/:id` | request form | 404 unknown/expired, 410 used |
| `POST /r/:id` | submit values | body `application/x-www-form-urlencoded` or JSON: `{ values: { NAME: string }, depository, scope }`; atomic single-use; 200 done page; 410 on replay; 413 over 64 KB |
| `GET /v/:id` | reveal page shell (no value) | 404/410 as above |
| `POST /v/:id/reveal` | returns the value once, burns the id | JSON `{ name, value }`; only route that ever carries a value; never logged |
| `GET /static/*` | css/js | CSP `script-src 'self'` |
| `GET /healthz` | liveness | `{ ok: true }` |

Headers on every response: `Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

## 3. CLI (`enigma`)

```
enigma add NAME [--depository ID] [--scope project|global] [--description TEXT] [--usage interactive|unattended]
enigma request NAME... [--depository ID] [--scope …] [--remote] [--native] [--timeout-min N]
enigma reveal NAME [--clipboard]
enigma list [--scope …] [--json]
enigma remove NAME [--scope …]
enigma move NAME --to ID
enigma run [--only A,B] [--scope …] -- <command> [args...]
enigma get NAME            # humans/scripts; stderr warning; blocked for the agent by the read-guard
enigma import [PATH] [--depository ID]
enigma doctor [--json]
enigma install             # register marketplace + enable plugin
```

Exit codes: 0 ok, 1 Enigma error (code printed), 2 usage. `run` exits with the child's code.

## 4. File formats

`~/.config/enigma/index.json` (0600):
```json
{ "version": 1, "entries": [ { "name": "OPENAI_API_KEY", "scope": "project", "projectId": "9f3a…", "projectPath": "/abs/path", "depository": "keychain", "ref": "9f3a…/OPENAI_API_KEY", "description": "…", "usage": "interactive", "createdAt": "ISO", "updatedAt": "ISO" } ] }
```

`~/.config/enigma/audit.log` (0600, JSONL):
```json
{ "ts": "ISO", "op": "set|rotated|read|reveal|remove|move|import|leak", "name": "…", "scope": "…", "depository": "…", "actor": "agent|user|cli|hook", "ok": true, "error": null }
```

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

**What these two guarantee, and what they don't** (state this accurately wherever either is described — a control that overstates itself is worse than one that states its limits): the read-guard stops an agent from reading a secret *by accident* (grepping the repo, catting a `.env`, echoing a tracked name); shell word-splitting (`${IFS}`) and ANSI-C quoting (`$'...'`) are normalized before matching, since they're the cheapest and most common ways to dodge a plain-text match, but neither the read-guard nor the tripwire is a sandbox, and neither stops an agent deliberately evading them (variable indirection, an assembled `eval`, writing and running a script, reading through an interpreter, an encode/decode round-trip). A `source`/`.`-style load of `.env` into the current shell is denied outright by the read-guard specifically because, once past it, it surfaces in **neither** layer — the tripwire only ever sees a value that's actually printed somewhere in tool output. The `${IFS}` normalization has no quote tracking and runs over the whole command regardless of single/double quotes, so it can also deny a single-quoted literal that merely looks like a `.env` reference once collapsed (e.g. `echo '${IFS}.env'`) even though bash itself would never expand `${IFS}` there — an accepted, narrow false positive (denial, never a bypass), not a bug to be "fixed" with real quote parsing.
