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

### Index write serialization (Issue #66)

Every index write goes through `mutateIndex(delta)` in `src/core/index-store.ts`, which holds an interprocess lock at `<ENIGMA_HOME>/index.lock` (mode 0600) for the duration of a synchronous re-read → delta → atomic-rename critical section. Slow depository I/O (1Password prompts, keychain operations) stays outside the lock. The four index writers — `setSecret`, `deleteSecret`, `move` (transitively via `setSecret(..., rotate: true)`), and `import-commit` (transitively via per-entry `setSecret`) — all reach it.

**Mechanism (kernel descriptor lock).** Exclusion is a kernel `flock(2)` (`LOCK_EX` on the open file description) on a **persistent anchor file**, through the first-party N-API addon `native/index-lock.cc` committed per platform under `plugins/enigma/native/<os>-<arch>/` (targets: darwin-arm64, darwin-x64, linux-x64; ABI-stable N-API v8). The anchor is created once (`O_EXCL`) and is **never renamed, unlinked, or replaced** — release is `flock(LOCK_UN)` + `close` in `finally`; the file's body (optional `<pid>\n<createdAtMs>\n`, written only after the lock is held) is informational metadata, never read for safety, and a leftover legacy body is simply overwritten. Acquisition is a bounded non-blocking retry loop (~500 ms) ending in `E_LOCK_TIMEOUT` naming the path; no raw `node:fs` error escapes `mutateIndex`. Unsupported platforms fail closed (`E_LOCK_UNAVAILABLE`) — there is no pure-JS fallback protocol by design. Artifact provenance (binary digest, source staleness metadata, toolchain, glibc symbol audit) is recorded in each artifact's `manifest.json` and enforced by `npm run check:native`, which validates the **committed** bytes a marketplace install runs — see `native/PROVENANCE.md` for exactly what is and is not claimed. Artifact selection is deterministic and layout-bound: a bundled module (`<pkg>/dist/*.mjs`) resolves only its own sibling `<pkg>/native/<tag>/`, the source tree resolves only `<repo>/plugins/enigma/native/<tag>/`, and `ENIGMA_NATIVE_DIR` is an authoritative override (the only location consulted when set — an invalid override fails closed rather than falling back). There is no cwd or ancestor search, so a missing installed artifact can never silently load a foreign checkout's native code — the addon and the JS lock protocol are versioned together.

**Crash recovery and liveness.** The kernel releases the lock on any process death, including SIGKILL — a crashed holder can never wedge the index, and no staleness heuristic, pid guess, or body age check exists or is needed. A paused but alive owner is waited out and never evicted: waiters time out (`E_LOCK_TIMEOUT`) instead of stealing. `enigma doctor` can hint at running writers; it does **not** prove all writers are stopped.

**Migration (stop/restart all writers).** The lock protocols are not version-negotiated: this kernel-lock scheme **supersedes** the earlier `O_EXCL` + stale-threshold name-based protocol (removed in full, not layered). A long-running MCP server keeps the old protocol in memory until it restarts, and an old-protocol process can unlink/replace the anchor, splitting exclusion across two inodes — so upgrade means stopping/restarting **every** Enigma writer (MCP servers, CLI, hooks) before swapping files. There is **no mixed-protocol guarantee**.

`deleteSecret` resolves and deletes from the depository *before* acquiring the lock, then removes the exact entry deleted (matched by name+scope+projectId **and** `ref`, not a fresh scope resolution) inside the lock — refusing with `E_NOT_FOUND` rather than guessing if that entry is gone or changed by the time the lock is acquired, so a same-name entry committed by a different scope during the depository await is never removed by mistake. Refs are stable addresses rather than content generations; the exact-entry match narrows the window but the residual same-name rotate/delete races remain, and Issue #70 (rotate cleanup) is the right place for them. A known limitation: two concurrent `set` calls with `rotate=false` for the same name may leave the loser's value as an orphan in the depository (the index reflects the winner).

### Project identity vs location (Issue #67)
Two functions, one rule each, both pure fs with no child process:
- `findProjectPath(cwd)` is lexical — walks up to the first `.git` entry and returns that directory (or `cwd` when none is found). It is the project's *location*: the directory whose `.env` the `env` depository reads/writes, whose `.gitignore` `checkEnvGitignore` reads, and whose basename the 1Password item title uses. It is unchanged from 0.2.0.
- `findRepoIdentityPath(cwd)` is canonical — it returns the common git dir's realpath, with the trailing `.git` stripped. Algorithm: walk up to the first `.git` entry (same as `findProjectPath`); if it is a directory, the common dir is that directory; if it is a file, parse its `gitdir:` pointer (relative or absolute; trimmed of CRLF and surrounding whitespace; `gitdir:` accepted with or without a space after the colon), resolve it against the `.git` file's directory, and if a `commondir` file exists at the resolved gitdir, use its contents resolved against the gitdir. `realpath` the common dir; if its basename is `.git`, return its parent, otherwise return it (bare repos return the bare dir). Any read/parse/realpath failure falls back to `realpath(worktreeRoot)`. `projectId(cwd)` hashes this canonical path (still the first 16 hex chars of sha256), so two linked worktrees, a submodule and its worktree, or a clone reached through a symlink all share one id; entries stored under 0.2.0 from a linked worktree, a symlinked path, or a submodule become invisible until `enigma migrate-scope` re-keys them — there is no read fallback, by user decision.

## ADR-004 — Hooks are the enforcement layer MCP cannot provide (D3.3–D3.4)
- PreToolUse read-guard denies reads of `.env*`, Enigma's config directory, `env`/`printenv`, `echo $NAME` for known names, `enigma get|env`, `security find-generic-password`, `op read`.
- PostToolUse tripwire scans tool output for values from `encrypted` and `env` by default (keychain opt-in, 1Password never, to respect prompt profiles), writes audit op `leak`, and returns a `systemMessage`. Claude Code has no output-rewrite hook, so the tripwire warns rather than redacts.
- SessionStart injects registered names (plus sticky default / manifest gaps) into context; nothing is written to `CLAUDE_ENV_FILE`. SessionStart is intentionally separate from the request store: it runs as a short-lived subprocess, so it cannot see in-memory state held by the MCP server, and the recovery signal for a fulfilled-but-unconsumed request/import is exposed only via `enigma_doctor` (the MCP process, where the store is live). The names it returns for a partial-failure record are the names in `record.results` (what the web POST handler actually processed), not `record.names` (what the agent originally requested) — Issue #68.

## ADR-005 — Local HTTP server design (D2.2, D2.6–D2.8)
- `node:http` on `127.0.0.1` ephemeral port inside the MCP process; idle shutdown after 10 min.
- Templates are real HTML files bundled as text; CSP `script-src 'self'`; no inline scripts.
- Remote access is opt-in per request: cloudflared quick tunnel or Tailscale serve, tunnel lifetime = request lifetime; QR of the public URL on the local page. Non-localhost plain HTTP is refused unless the host is in the Tailscale range (harvested `network-policy`).
- No PIN on links in v1 (V2 candidate).
- The request form accepts names beyond the ones the agent asked for (Issue #71): `+ Add secret` rows and a pasted `.env` blob. The blob is one form field, parsed on submit by the existing `parseDotEnv` — there is deliberately no parse-and-echo endpoint, because a JSON endpoint returning `{name, value}` would put a value in an HTTP response body (S2.4). Invariant: name text a human typed or pasted only ever reaches a response body, log, audit line or outcome text after passing `validateName`; anything else is counted and discarded. The 25-name cap and duplicate/ambiguity checks run before the request id is consumed.

## ADR-006 — Packaging (D5.1–D5.6)
- Repo is marketplace `clarit-enigma` and npm package `@clarit.ai/enigma`; plugin at `plugins/enigma`.
- Pre-bundled `dist/*.mjs` committed per release; `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json` and hooks; no postinstall.
- CI on every PR: lint, typecheck, tests, leak fence, `npm audit`.

## ADR-007 — ClawVault is harvested, not forked
- Reused nearly verbatim: request store, network policy, Linux secret-service write pattern and detection probe, the audit decorator idea, the AES-256-GCM layout, the static leak-fence idea.
- Not carried: gateway/OpenClaw code, Express and string-built HTML, `dump-keychain` listing, argv secret passing, the `/manage` dashboard.
