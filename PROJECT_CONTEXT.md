# PROJECT_CONTEXT.md — Index File

> Master index for Enigma. It routes; detailed content lives in `docs/`.
> The `/dev` skill reads this file at every Phase to restore context.

---

## Repository Info

- **Repo URL**: https://github.com/Clarit-AI/enigma
- **Main branch**: main
- **Created**: 2026-09-15
- **License**: Apache-2.0, public
- **Product requirements**: [PRD.md](PRD.md) (frozen 2026-09-15, 34 decisions D1.1–D5.7)

---

## Sub-document Index

| File | Content | Update timing |
|------|---------|---------------|
| `docs/glossary.md` | Canonical terminology (depository, prompt profile, scope, request, reveal) with avoid-words | Correct when term drift is detected |
| `docs/tech-stack.md` | Runtime, language, build, test, dependency policy | When tech choices change |
| `docs/architecture.md` | ADRs: the invariant, elicitation, storage model, hooks, packaging | Immediately when a decision is made |
| `docs/api-contracts.md` | MCP tool schemas, local HTTP routes, CLI commands, file formats | When an interface is added or changed |
| `docs/style-guide.md` | Naming, directory layout, error-handling and secret-handling conventions | When conventions change |
| `docs/feature-log.md` | Completed features (PR, merge date) and known tech debt | Every Phase 5 round |

---

## Current Status

- **Last updated**: 2026-09-15
- **Current iteration goal**: v1 — Modules 1–5 of the PRD
- **Open PRs**: none
- **Known tech debt**: see the bottom of `docs/feature-log.md`

---

## Architecture Decision Checklist (Phase 2 checkpoint, confirmed 2026-09-15)

- **Auth scheme**: none. Enigma is local-only; one-time request/reveal ids (128-bit random, single-use, TTL) are the only bearer. No accounts, no sessions.
- **API design spec**: MCP tools `enigma_<verb>` with zod schemas; local HTTP routes `/r/:id`, `/v/:id`; unified error shape `{ error: { code, message } }` with no secret values in any message. See `docs/api-contracts.md`.
- **Database schema**: none. Names-only index at `~/.config/enigma/index.json`; audit JSONL at `~/.config/enigma/audit.log`; encrypted entries in `~/.config/enigma/secrets.enc`. Formats in `docs/api-contracts.md`.
- **Database migration**: none (greenfield). Index and vault files carry a `version` field for future migration.
- **API contract document**: `docs/api-contracts.md` is required and is the contract workers implement against.
- **Code style**: `docs/style-guide.md`.

---

## Execution Routing Policy

```yaml
implementation:
  harness: claude
  model: sonnet
  profile: null
  reasoning_effort: high
  permission_mode: full_access
fix:
  harness: claude
  model: sonnet
  profile: null
  reasoning_effort: high
  permission_mode: full_access
prototype: {}
qa:
  harness: qwen
  model: gemini-3.8-flash-high
  profile: null
  reasoning_effort: null
  permission_mode: full_access
review:
  harness: codex
  model: gpt-5.6-sol
  profile: null
  reasoning_effort: high
  permission_mode: full_access
```

Lanes that must run Claude-native executable skills stay on `claude`. Per the standing approval of 2026-09-08, a delegated lane may move to Opus or Fable when the task genuinely needs it; the lead states why. `full_access` is Traycer's default; QA and review are read-only by prompt and are verified by clean-worktree and unchanged-head checks.

---

## External Review Policy

- **Mode**: auto
- **Trusted reviewers**: coderabbit, kilo, github-copilot
- **Required reviewers**: none
- **Ignored reviewers**: none
- **Additional reviewer identities**: none
- **Default wait minutes**: 10
- **Allow automatic review requests**: false

---

## Verification Gate

Commands exist after the scaffold Issue lands; until then the gate is `n/a`.

- **Lint**: `npm run lint`
- **Type check**: `npm run typecheck`
- **Static analysis**: `npm run leak-fence` (static scan asserting no value-returning storage call is reachable from `src/mcp/**` or `src/web/**`, and no depository passes a value via argv — it matches call shapes only, not field assignments; see that script's header comment and `test/unit/reason-field-surfaces.test.ts` for what covers the gap, Issue #38)
- **Dependency scan**: `npm audit --audit-level=high`
- **Tests**: `npm test`, or `npm run test:file -- <path>` for a single file or a repeat loop

**Gate commands must be run through the npm scripts above, always preceded by `npm ci` in a fresh checkout or worktree — never via a bare `npx <tool>`.** `npx vitest run <file>`, the command anyone reaches for to run one file or a repeat loop, checks local `node_modules/.bin` first but silently falls back to a cached or global install when `node_modules` is empty or missing that package — so a lane that runs it before `npm ci` gets a result from whatever version happens to be cached, not the version this repo pins, with no indication anything is wrong. `npm run <script>` does not have this failure mode on its own (npm always resolves from `node_modules/.bin` and fails loudly if the binary is absent), which is why it stays the required form. This cost real time once: a lane ran `npx vitest run <file>` before `npm ci`, silently got a cached `vitest@4.1.11` instead of the pinned `^5.0.1`, and a test failure that only existed under the wrong runner was investigated as a genuine pre-existing bug on `main` (Issue #29). `npm run lint`/`npm run typecheck`/`npm test` (and `npm run test:file`) now each run `scripts/check-toolchain.mjs` first, which fails with an actionable message naming `npm ci` if `vitest`, `typescript`, or `eslint` in `node_modules` is missing or does not satisfy its pinned range in `package.json`; `vitest.config.ts`'s `globalSetup` runs the same check, so even a bare `npx vitest` — the one path that bypasses the npm scripts entirely — still fails loudly instead of silently, because it still loads this repo's vitest config. This does not cover a bare `npx eslint`/`npx tsc`: those have no equivalent repo-config hook to run the guard unconditionally, so they are simply not a blessed way to run this project's checks — use the npm scripts.

---

## GitHub account isolation (this machine)

This repository belongs to the `Clarit-AI` GitHub account. Every `gh` and `git` write in this project runs with `GH_CONFIG_DIR=/Users/bbrenner/.config/gh-clarit`.

**Scope**: `.claude/settings.local.json` sets that variable for the lead session only — it does not reach child agents, so it protects the lead session and nothing else. Every **delegated lane** — worker, QA, reviewer, and prototype alike, not just worker lanes — must have `GH_CONFIG_DIR=/Users/bbrenner/.config/gh-clarit` exported explicitly in its own assignment. A lane dispatched without that export authenticates `gh` under whatever account is ambient on this machine instead; that has already happened once, when a QA or reviewer lane posted to GitHub under the wrong account because the standing brief only named worker lanes (Issue #33).

Git credentials are themselves routed by remote URL path, so a push to `Clarit-AI/*` never uses the KHAEntertainment token — but only once the right `gh`/`GH_CONFIG_DIR` is actually in scope for that process. Author identity for this folder is `Clarit AI <info@clarit.ai>`.

Exporting `GH_CONFIG_DIR` in a shell is not enough for `git push` specifically: the credential helper (`gh auth git-credential`) runs as a subprocess of `git`, not of the shell that ran the export, so a plain `git push` after a separate `export GH_CONFIG_DIR=...` fails with `fatal: could not read Password for '...': Device not configured`. Pass it inline on the push itself (and on any `gh` invocation that triggers a git write) — `GH_CONFIG_DIR=/Users/bbrenner/.config/gh-clarit git push ...` — rather than relying on a prior export to still be in scope.

---

## Verification lane storage sandboxing

**Scope**: any lane — worker, QA, reviewer, or prototype — whose assignment runs the real `enigma` tool (not just its unit tests) against local state.

Two real locations must be sandboxed, not one:
- `ENIGMA_HOME` — Enigma's own config/secret-store directory (default `~/.config/enigma`): `index.json`, `audit.log`, `secrets.enc`, `enigma.key`.
- `CLAUDE_CONFIG_DIR` — the editor-side config `enigma install`/`enigma doctor` read and write (default `~/.claude`): `settings.json`.

Both variables must point at a lane-local temp directory before the tool runs. Sandboxing only one is not a lesser version of this rule, it is a different rule that doesn't hold: a brief that named only `CLAUDE_CONFIG_DIR` once let verification lanes run the real tool against the user's real `~/.config/enigma`, and five orphaned entries landed in the real index before anyone noticed (Issue #43). No secret *values* leaked in that incident — the index holds names and metadata only, which is ADR-001 holding even in a case nobody intended to test — but `set`/`import` also write to the OS keychain and, on some depository paths, to 1Password, and those writes outlive a temp-directory cleanup; they are not undone by deleting the worktree.

Every lane report states the end state of **both** real locations — `~/.config/enigma` and `~/.claude/settings.json` — normally by checksum, so a lead can confirm nothing leaked into them even when the lane's own sandbox worked as intended.

**This sandbox has a hole: it does not reach the `keychain`, `secret-service`, or `1password` depositories, at all.** `ENIGMA_HOME` and `CLAUDE_CONFIG_DIR` relocate Enigma's *own* on-disk state — the two variables above. They cannot relocate the *destinations* a `keychain`-, `secret-service`-, or `1password`-scoped entry actually writes to: the macOS login keychain, the Linux D-Bus secret service, and a 1Password vault are all global OS or account resources, addressed by the OS/account itself, with no environment variable that redirects any of them. A fully sandboxed `ENIGMA_HOME` gives false confidence the instant a command exercises any of those three depositories — confirmed the hard way when a fully-sandboxed verification lane ran `enigma move API_KEY --to keychain` and it wrote a real item into the real login keychain (Issue #53). This is exactly the survival mode Issue #43 warned about — "those writes outlive a temp-directory cleanup" two paragraphs up — now confirmed to defeat the sandbox variables directly, not just a forgotten cleanup step.

**The actual rule for these three depositories: don't exercise them against real credentials in verification work.** Use the `env` or `encrypted` depository in any lane assignment, fixture, or manual probe that needs a working depository end-to-end — neither touches a global resource, so both are fully covered by the `ENIGMA_HOME` sandbox above. If a lane substitutes a fake binary on `PATH` instead (e.g. to make a keychain write fail on purpose), that fake **must be verified to be the binary actually invoked** — see the next paragraph for why that verification step is not optional.

**A fake `security` on `PATH` does not work — confirmed by reading the code, not assumed.** `src/storage/depositories/macos-keychain.ts` hardcodes `SECURITY_BIN = '/usr/bin/security'`, an absolute path, and calls it via `execFile(SECURITY_BIN, …)` with no shell. Node resolves an absolute path exactly the way `execve` does: never through `PATH`. Prepending a fake `security` to `PATH` therefore has zero effect on this depository, silently — the real binary runs every time, with no error to signal that the fake was skipped. This is precisely what happened in Issue #53: a "deliberately failing fake `security`" was on `PATH`, expecting the keychain write to refuse, and the real write went through instead. **`1password` and `secret-service` are both different, and the same technique is not safe to assume there either**: `src/storage/depositories/onepassword.ts` invokes `op` by bare name (`OP_BIN = 'op'`), and `src/storage/depositories/linux-secret-service.ts` invokes `secret-tool` the same way (`SECRET_TOOL_BIN = 'secret-tool'`) — a bare command name passed to `execFile` *does* get resolved through `PATH`, so a fake `op` or `secret-tool` shim placed earlier on `PATH` would in fact be picked up. Treat "put a fake binary on `PATH`" as depository-specific and unverified by default in either direction: for `keychain` it structurally cannot work (absolute path, no exceptions); for `1password` and `secret-service` it can work but nothing in the codebase confirms which binary a given shell session will actually resolve first. Either way, print `type security` / `type op` / `type secret-tool` (or equivalent) and assert on the fake's own sentinel output before trusting that the write refused for the reason you intended, rather than after the fact. This project is Mac-first but cross-platform by design — don't generalize "PATH shadowing doesn't work here" from the `keychain` case to the other two; it's the opposite of true for them.

**The safe way to exercise any of these depositories' code paths without touching the real destination is a module-level mock, not a `PATH` trick.** `test/setup.ts` already does this for the automated suite: it mocks `node:child_process`'s `execFile` before any depository code runs, so no test — whether or not it knows a shell-based depository exists — can reach a real binary by accident. That mechanism only exists inside the vitest process; there is no equivalent for a manual CLI probe (`enigma move … --to keychain` typed or scripted outside the test runner), because outside the test suite the tool has no way to tell a verification lane's invocation apart from a real user's. That is also the reason a code-level opt-in guard on these three depositories was considered and rejected for now: unlike `test/setup.ts`'s guard, which only ever gates a context (vitest) that is never real usage, a guard inside `createKeychainDepository`/`createOnepasswordDepository`/`createSecretServiceDepository` would gate *every* real `enigma set`/`move --to keychain` invocation too — including the tool's actual primary use — forcing an opt-in flag into ordinary product operation. That flag would then get copy-pasted into every verification lane brief exactly as routinely as the `ENIGMA_HOME` export is today, protecting nothing while making the product itself more annoying to use for its intended purpose. The fix for "a lane runs the real tool while believing it is sandboxed" is this documentation, not a second mechanism with the same failure mode. Revisit this only if a concrete design surfaces that can tell verification from real use without penalizing real use.

**Cleanup, because it will happen again.** List what a service name has under it — one item per call, not an enumeration:

```
security find-generic-password -s enigma
```

A single call only ever surfaces the first match; a project with several leaked entries needs the loop below, not one call. Delete a specific entry once you have its `-a` value (ref convention is `<scopeId>/<NAME>`, e.g. `4fbdba9dacb67fb5/API_KEY`):

```
security delete-generic-password -s enigma -a "<scopeId>/<NAME>"
```

To confirm nothing enigma-related remains, repeat find-then-delete until it reports not found — this is destructive by design (each call consumes the match it finds), which is also what makes it a reliable enumeration when you don't already know every ref:

```
while security find-generic-password -s enigma > /tmp/_enigma_kc_hit 2>&1; do
  acct=$(sed -n 's/.*"acct"<blob>="\([^"]*\)".*/\1/p' /tmp/_enigma_kc_hit)
  security delete-generic-password -s enigma -a "$acct"
done
```

---

## Verification lane worktree isolation

**Scope**: any time two or more delegated lanes (typically a QA lane and a reviewer lane) are dispatched against the same change.

Two lanes must never be pointed at the same worktree. The mechanism: `git branch verify/<n>-<lane> <head>` to cut one throwaway branch per lane from the commit under test, then a separate `git worktree add` per lane checking out its own branch — because git refuses to check the same branch out into two worktrees at once, this forces one directory per lane rather than relying on lane authors to remember it. Each lane then has its own directory and its own branch; neither can see the other's probe files or fixture edits.

This isn't a formality: for several rounds, QA and review shared one worktree, wrote probe files into the same tree, found each other's leftovers, and one reviewer corrected a bug in the other lane's fixture without either lane knowing the other existed (Issue #36). Two lanes reading one directory are not two independent reads — they are one shared mutable directory with two writers.
