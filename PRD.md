<!-- phase1-progress: ALL MODULES LOCKED at 2026-09-15 21:30 -->
<!-- modules: 1.Storage core 2.Request and reveal flow 3.Agent integration 4.CLI and import 5.Packaging and distribution -->

# Enigma — PRD (draft)

Basis: approved plan at /Users/bbrenner/.claude/plans/greenfield-project-tentative-giggly-dragon.md (Situation A). This draft records only decisions locked in Phase 1 alignment on top of that plan.

## Module list (locked 2026-09-15 20:54)
1. Storage core — canonical naming, index, audit log, config, backends (env, encrypted, keychain, secret-service, 1Password)
2. Request and reveal flow — one-time request store, local HTTP server and templates, network policy, native macOS adapters, tunnel and QR
3. Agent integration — MCP server and tools, URL elicitation with fallback, hooks, skill, slash commands
4. CLI and import — enigma CLI, run injection, import, secrets manifest, doctor
5. Packaging and distribution — plugin and marketplace manifests, npm install, CI and release, evals, docs

Dependencies: 2 and 4 build on 1; 3 builds on 1 and 2; 5 wraps all.

## Module 1: Storage core (locked 2026-09-15 21:16)

**Goal and boundary**: stores values keyed by (scope, NAME); knows nothing about MCP, HTTP, or UI. Public operations: set, delete, has, list, move. Internal-only resolve used by `run`, reveal, and the tripwire hook.

**Key decisions**:
- D1.1 Project identity is the canonical repository identity (the common git dir's realpath, stripped of its trailing `.git`), used for the index key hash; project location is the lexical worktree root (`findProjectPath(cwd)`, the first `.git` entry walking up), used for project-local files (the `env` depository's `.env`, `checkEnvGitignore`, the 1Password item title) and the stored `IndexEntry.projectPath`. Two function calls: `findRepoIdentityPath(cwd)` returns the canonical identity (one rule, pure fs, no child process — `.git` directory → that directory; `.git` file → parse `gitdir:` and optional `commondir`, realpath the result); `findProjectPath(cwd)` stays lexical and unchanged. `projectId(cwd)` hashes the identity path (still the first 16 hex chars of sha256). A clone reached through a symlinked path hashes the physical path, so its id differs from 0.2.0's; cwd fallback when not a git repo.
- D1.2 No silent default depository. Without an explicit choice the request form shows a picker. Each depository carries a prompt profile: `none` (encrypted, env), `may-prompt` (keychain, secret-service), `prompts-each-read` (1password). The agent passes a usage hint (`interactive` | `unattended`) that preselects a recommendation; the skill instructs the agent to explain the trade-off first. Sticky defaults are opt-in via config (project or global).
- D1.3 Overwrite requires `rotate: true` and a visible warning on the form; without it the tool returns "already exists". No value history. Audit op `rotated`. A same-depository rotate also removes the displaced old copy (Issue #70): best-effort after the index commit, never when the storage location is unchanged, and a cleanup failure warns + audits without failing the rotate.
- D1.4 Read failures fail fast with name + depository in the error, never a value, never cross-depository fallback. `enigma move NAME --to <depository>` ships in v1.
- D1.5 Project scope shadows global for reads; `list` marks shadowed rows; `remove` requires explicit scope when both exist.
- D1.6 Canonical term **depository** (see glossary). Identifiers: `env`, `encrypted`, `keychain`, `secret-service`, `1password`. Flag `--depository`, short `--to` on move/add.
- D1.7 `encrypted`: random 256-bit key at `~/.config/enigma/enigma.key` (0600), per-entry AES-256-GCM in `~/.config/enigma/secrets.enc`; no derivation, no keychain-held key. Threat model documented: protects against repo/backup/disk exposure, not same-user malware.
- D1.8 Index `~/.config/enigma/index.json` (0600): name, scope, projectPath, depository, ref, description, usage, createdAt, updatedAt. Audit `~/.config/enigma/audit.log` (0600, JSONL): ts, op (set|rotated|read|reveal|remove|move|import|migrate|leak), name, scope, depository, actor (agent|user|cli|hook), ok, error, projectId?/projectPath? (project scope only, Issue #80). Never values.
- D1.9 Keychain: service `enigma`, account `<scope-id>/<NAME>`. 1Password: vault `Enigma` created on first use after one-time confirmation; API Credential items, value in `credential`; title `NAME` (global) or `NAME · <project folder>` (project); reads by item id from the index.

**Stress-test scenarios (user confirmed; become acceptance tests)**:
- S1.1 Same project cloned to a new folder: new project hash, so project-scoped secrets are not found; `list` and doctor show them under the old path; user can `move`/re-request or use global scope.
- S1.2 `enigma.key` deleted mid-run: already-injected child process unaffected; next resolve fails fast naming `encrypted`; doctor reports the key missing and the vault file unreadable.
- S1.3 Unattended hint but user picks 1Password: allowed; picker shows the `prompts-each-read` warning; index records usage=unattended so doctor can flag the mismatch.
- S1.4 Linked worktrees of one repository share `scope: 'project'` (Issue #67): `projectId` is the canonical repository identity, not the worktree root; an entry stored from worktree A is visible from worktree B (and a submodule's linked worktree, or a clone reached through a symlink, joins the same id only after canonicalization). `findProjectPath` stays lexical, so the `env` depository still writes to the writer's `.env` and reads it from the index entry's stored `projectPath`. Entries saved under 0.2.0 from a linked worktree, a symlinked path, or a submodule become invisible until `enigma migrate-scope` re-keys them — there is no read fallback, by user decision.

**Known open items**: none blocking.

**V2 candidates raised here**: remote/phone approval for 1Password reads (investigate Service Accounts as the unattended route).

## Alignment mode change (user decision)

The user approved fast-forwarding Modules 2-5 from the approved plan: the Tech Lead locks decisions already answered by the plan without per-question confirmation and asks only where feedback is genuinely needed. The user actively opted out of per-module scenario stress-tests for Modules 2-5 and accepts that risk; the Tech Lead records stress scenarios as acceptance tests instead.

## Module 2: Request and reveal flow

**Goal and boundary**: turns "the agent needs a secret" or "the user wants to see a secret" into an out-of-band interaction whose value never touches MCP traffic, stdout, or the transcript. Owns the one-time request/reveal store, the local HTTP server and templates, network policy, the native macOS adapters, and remote access.

**Key decisions**:
- D2.1 Request store harvested from ClawVault: 128-bit random id, atomic single-use, waiter promises typed `Promise<'fulfilled'>`, sweeper with 5-minute grace. Request TTL 15 min; reveal TTL 5 min.
- D2.2 Local server on `127.0.0.1` ephemeral port, started lazily inside the MCP server process on first request, stopped when idle for 10 min. Routes: `GET/POST /r/:id` (request form), `GET /v/:id` + `POST /v/:id/reveal` (reveal page), `GET /static/*`. CSP `script-src 'self'`, no inline scripts, 64 KB body cap, per-IP rate limit.
- D2.3 One form can collect several secrets; each row shows name, description, usage hint, and the depository picker (D1.2) with prompt-profile labels; existing names show the rotate warning (D1.3).
- D2.4 Reveal page requires an explicit "Reveal" click before the value is fetched (defeats link-preview fetchers), burns the request on that click, shows name, scope, project, timestamp, copy button, auto-blanks after 60 s.
- D2.5 Native macOS adapters: request via `osascript` `display dialog … with hidden answer`, script supplied on stdin, one dialog per secret; reveal via `pbcopy` from within the process with auto-clear after 60 s when the clipboard still holds the value. Selected with `ui: "native"` / `method: "clipboard"`; default remains web.
- D2.6 Remote access opt-in per request (`remote: true`) or via config: `cloudflared tunnel --url http://127.0.0.1:<port>` (public HTTPS quick tunnel, URL parsed from stderr) or `tailscale serve`. Tunnel lifetime = request lifetime. The local page shows a QR code of the active public URL when a tunnel is up. Network policy harvested: non-localhost plain HTTP refused unless Tailscale range.
- D2.7 Templates are real `.html` files bundled as text; no string-built HTML. Visual identity: Clarit brand tokens; dark/light via `prefers-color-scheme`; mobile-first layout.
- D2.8 No PIN on links in v1 (V2 candidate). Mitigations: single-use, short TTL, explicit click on reveal, request links can only *set* values.

**Acceptance scenarios**: S2.1 replayed request link → 410 and no write. S2.2 expired reveal link → 404, audit shows no reveal. S2.3 tunnel process dies mid-request → local URL still works, tool result reports the tunnel loss by name only. S2.4 response bodies and server logs never contain a sentinel value submitted through the form.

## Module 3: Agent integration

**Goal and boundary**: everything Claude Code touches. MCP stdio server with a names-only tool surface, URL-mode elicitation with a fallback for clients without it, three hooks, the skill, and five slash commands.

**Key decisions**:
- D3.1 Tools: `enigma_list`, `enigma_request`, `enigma_await`, `enigma_reveal`, `enigma_remove`, `enigma_import`, `enigma_doctor`. No tool ever returns a value. `enigma_request` accepts `names[]`, `reason`, `usage`, optional `depository`, `scope`, `rotate`, `ui`, `remote`.
- D3.2 If the client advertises `elicitation.url`, `enigma_request` and `enigma_reveal` send `elicitation/create {mode:"url"}` and block until the store resolves, then return a names-only summary. Otherwise the tool returns the URL and a `request_id`; `enigma_await(request_id)` blocks. `enigma_remove` uses form-mode boolean confirmation (permitted by spec).
- D3.3 Hooks in `hooks/hooks.json`, entrypoint `dist/hooks.mjs <event>`: SessionStart (additionalContext: names available for this project, sticky default if any, manifest gaps); PreToolUse read-guard on Read/Bash/Grep/Glob (deny `.env*` except `.env.example`, `~/.config/enigma/*`, `env`/`printenv`, `echo $NAME` for known names, `enigma get|env`, `security find-generic-password`, `op read`, `cat|grep|sed|awk|head|tail` of `.env`); PostToolUse tripwire on Bash/Read/Grep and MCP tools.
- D3.4 Tripwire scope corrected for prompt profiles: scans values from `encrypted` and `env` by default; `keychain`/`secret-service` opt-in via config; `1password` never (a scan on every tool call would trigger a biometric prompt each time). Sync, 5-s timeout, skips outputs over 1 MB, fails open, writes audit op `leak`, returns `systemMessage` naming the secret and advising `rotate: true`.
- D3.5 Skill `skills/enigma/SKILL.md`: when a task needs a credential, never ask the user to paste; explain depository trade-offs using prompt profiles and usage; call `enigma_request`; use `enigma run --` for keychain/1Password/encrypted secrets; treat read-guard denials as instructions, not obstacles.
- D3.6 Slash commands: `/enigma:request`, `/enigma:reveal`, `/enigma:list`, `/enigma:remove`, `/enigma:doctor`, `/enigma:import`; `reveal` and `import` marked `disable-model-invocation` (user-only). `/enigma:remove` was added after the initial freeze, in Issue #79 (shipped 2026-09-23, PR #81) — it wraps the pre-existing `enigma_remove` MCP tool.

**Acceptance scenarios**: S3.1 "add my OpenAI key" → `enigma_request` called, transcript contains no sentinel. S3.2 Bash `cat .env` → denied with reason mentioning `enigma run`. S3.3 Bash `echo <sentinel from encrypted>` → tripwire systemMessage + audit `leak`. S3.4 client without elicitation → URL + `enigma_await` path works.

## Module 4: CLI and import

**Goal and boundary**: the `enigma` binary for humans and scripts, plus the two project-level conveniences (import and manifest).

**Key decisions**:
- D4.1 Commands: `add NAME` (hidden interactive prompt), `request NAME...` (ephemeral server, prints URL/QR, blocks), `reveal NAME`, `list`, `remove NAME`, `move NAME --to`, `run [--only A,B] -- <cmd>`, `get NAME` (stdout, stderr warning; blocked for the agent by the read-guard), `import [path]`, `doctor`, `install` (Phase 5 registers marketplace/plugin). `--json` on read-only commands.
- D4.2 `run` resolves project then global, injects only into the child env, exits with the child's code; a resolve failure aborts before spawn (D1.4).
- D4.3 `import`: parses `.env`, moves each value into the chosen depository (picker on the web form, or `--depository`), rewrites the file to a `# enigma:begin/end` block for `env` or removes the keys otherwise, warns if `.env` is not gitignored, prints names only.
- D4.4 Manifest `.enigma.json` (committed): `defaultDepository` (optional sticky default), `secrets: { NAME: description }`. `doctor` and SessionStart report missing names so one request can collect them all.

**Acceptance scenarios**: S4.1 `enigma run -- printenv NAME` prints the value in a normal shell; the same via the agent's Bash tool is denied. S4.2 `import` on a 5-key `.env` leaves no plaintext values in the file. S4.3 manifest with 2 missing names → doctor lists exactly those.

## Module 5: Packaging and distribution

**Goal and boundary**: make Enigma installable three ways and releasable safely.

**Key decisions**:
- D5.1 Repo `clarit-ai/enigma` is marketplace `clarit-enigma` (`.claude-plugin/marketplace.json` → `./plugins/enigma`) and npm package `@clarit.ai/enigma` (`bin: enigma`).
- D5.2 Plugin ships pre-bundled `dist/{mcp-server,hooks,cli}.mjs` (esbuild, deps inlined) committed per release; `.mcp.json` and hooks use `${CLAUDE_PLUGIN_ROOT}`. No postinstall.
- D5.3 `npx @clarit.ai/enigma install` registers the marketplace and enables the plugin (claude-mem npx pattern). GitHub dev install: clone, `npm run build`, `claude --plugin-dir plugins/enigma`. **The npm path is shelved** (user decision, 2026-09-25): the package has never been published and the marketplace install is the sole supported method. Revisit as support for other harnesses grows.
- D5.4 CI on every PR: lint, typecheck, unit + integration tests, static leak fence, `npm audit`. Release: `claude plugin tag --push`; npm publish from tag remains defined but shelved with D5.3 — do not cut a `v*` tag while the channel is shelved, as it fires the release workflow and fails at publish.
- D5.5 `claude plugin eval` suite with the S3.x cases; docs in clarit-docs-voice; `docs/SECURITY.md` threat model.
- D5.6 Node 20+ engines field; ESM; TypeScript strict; vitest; eslint.

- D5.7 License Apache-2.0; repository public from the first commit.

## MVP scope
Modules 1-5 as locked above.

## V2 candidates (explicitly deferred)
- Hosted relay for mobile without a tunnel
- Remote/phone approval for 1Password reads; 1Password Service Accounts for unattended runs
- PIN-protected request/reveal links
- Windows DPAPI depository
- Codex / Cursor adapters (fallback path already keeps the door open)
- Remote Claude Code sessions (no keychain in sandbox)
- Team/shared secrets

## Explicitly will not build
OpenClaw support; a general secret manager UI; a hosted secret store; any tool that returns a value to the model.

## Technical constraints
Node 20+, TypeScript ESM, zero native modules, values never in argv, MCP URL-mode elicitation for credentials (spec 2025-11-25), Claude Code ≥ 2.1.76 for elicitation.

## Success criteria
- End-to-end request on this Mac stores a sentinel with zero occurrences in the session transcript.
- Read-guard and tripwire both fire in the S3 scenarios.
- 1Password round trip works with `op` signed in.
- Marketplace install from GitHub works with no npm install step.
