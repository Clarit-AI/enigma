# Architecture Decisions

Decision ids reference [PRD.md](../PRD.md).

## ADR-001 — The invariant: no code path returns a secret value to the model
- Decision time: 2026-09-15 (plan approval)
- The MCP server exposes no `get`. The only function that ever reads a plaintext value out of a depository is `Depository.resolve()`. `resolveSecret()` (`src/storage/manager.ts`) wraps it with naming validation, index lookup, and audit logging, and is called from five sites: `enigma run`, `enigma get`, `enigma move` (all CLI), the reveal web route (`POST /v/:id/reveal`), and the clipboard-reveal native path. The tripwire hook calls `Depository.resolve()` directly instead, deliberately bypassing `resolveSecret()`'s audit logging (it scans every tracked secret against every matching tool call, and going through the audited path would flood the audit log with a `read` line per candidate per call); only an actual leak hit is audited there, with op `leak`. The static leak fence (`npm run leak-fence`) fails CI if `src/mcp/**` or `src/web/**` references `resolve(`.
- Error messages, audit lines, logs, and tool results carry names and depository ids, never values.

## ADR-002 — Secret entry via MCP URL-mode elicitation (D2.1–D2.4, D3.2)
- The MCP spec (2025-11-25) forbids form-mode elicitation for credentials and mandates URL mode. Claude Code supports both since v2.1.76.
- `enigma_request` creates a one-time request, starts the local server lazily, and calls `elicitation/create { mode: "url" }`. The tool blocks on the request store's waiter and returns a names-only summary.
- Clients without `elicitation.url`: the tool returns the URL and `request_id`; `enigma_await` blocks.
- The elicitation URL contains only the random id (spec: never credentials or PII in the URL).

## ADR-003 — Storage model (D1.1–D1.9)
- Canonical name `^[A-Z][A-Z0-9_]*$`, validated once in `src/core/naming.ts`. Depositories encode, never validate.
- Scope `project` (git root path, hashed) or `global`; project shadows global.
- No silent default depository; picker with prompt profiles (`none`, `may-prompt`, `prompts-each-read`); agent passes a usage hint; sticky defaults are opt-in config.
- Index and audit are names-only files under `~/.config/enigma/` (0600).
- `encrypted`: random key file + per-entry AES-256-GCM; never prompts.
- Every OS integration receives the value on stdin: `security -i` (macOS), `secret-tool store` (Linux), `op item create` with a JSON template on stdin, `osascript` script on stdin.
- Reads fail fast with no cross-depository fallback; `enigma move` is the remedy.

## ADR-004 — Hooks are the enforcement layer MCP cannot provide (D3.3–D3.4)
- PreToolUse read-guard denies reads of `.env*`, Enigma's config directory, `env`/`printenv`, `echo $NAME` for known names, `enigma get|env`, `security find-generic-password`, `op read`.
- PostToolUse tripwire scans tool output for values from `encrypted` and `env` by default (keychain opt-in, 1Password never, to respect prompt profiles), writes audit op `leak`, and returns a `systemMessage`. Claude Code has no output-rewrite hook, so the tripwire warns rather than redacts.
- SessionStart injects registered names (plus sticky default / manifest gaps) into context; nothing is written to `CLAUDE_ENV_FILE`. SessionStart is intentionally separate from the request store: it runs as a short-lived subprocess, so it cannot see in-memory state held by the MCP server, and the recovery signal for a fulfilled-but-unconsumed request/import is exposed only via `enigma_doctor` (the MCP process, where the store is live). The names it returns for a partial-failure record are the names in `record.results` (what the web POST handler actually processed), not `record.names` (what the agent originally requested) — Issue #68.

## ADR-005 — Local HTTP server design (D2.2, D2.6–D2.8)
- `node:http` on `127.0.0.1` ephemeral port inside the MCP process; idle shutdown after 10 min.
- Templates are real HTML files bundled as text; CSP `script-src 'self'`; no inline scripts.
- Remote access is opt-in per request: cloudflared quick tunnel or Tailscale serve, tunnel lifetime = request lifetime; QR of the public URL on the local page. Non-localhost plain HTTP is refused unless the host is in the Tailscale range (harvested `network-policy`).
- No PIN on links in v1 (V2 candidate).

## ADR-006 — Packaging (D5.1–D5.6)
- Repo is marketplace `clarit-enigma` and npm package `@clarit.ai/enigma`; plugin at `plugins/enigma`.
- Pre-bundled `dist/*.mjs` committed per release; `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json` and hooks; no postinstall.
- CI on every PR: lint, typecheck, tests, leak fence, `npm audit`.

## ADR-007 — ClawVault is harvested, not forked
- Reused nearly verbatim: request store, network policy, Linux secret-service write pattern and detection probe, the audit decorator idea, the AES-256-GCM layout, the static leak-fence idea.
- Not carried: gateway/OpenClaw code, Express and string-built HTML, `dump-keychain` listing, argv secret passing, the `/manage` dashboard.
