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
- **Static analysis**: `npm run leak-fence` (static scan asserting no value-returning storage call is reachable from `src/mcp/**` or `src/web/**`, and no depository passes a value via argv)
- **Dependency scan**: `npm audit --audit-level=high`
- **Tests**: `npm test`

---

## GitHub account isolation (this machine)

This repository belongs to the `Clarit-AI` GitHub account. Every `gh` and `git` write in this project runs with `GH_CONFIG_DIR=/Users/bbrenner/.config/gh-clarit`.

**Scope**: `.claude/settings.local.json` sets that variable for the lead session only — it does not reach child agents, so it protects the lead session and nothing else. Every **delegated lane** — worker, QA, reviewer, and prototype alike, not just worker lanes — must have `GH_CONFIG_DIR=/Users/bbrenner/.config/gh-clarit` exported explicitly in its own assignment. A lane dispatched without that export authenticates `gh` under whatever account is ambient on this machine instead; that has already happened once, when a QA or reviewer lane posted to GitHub under the wrong account because the standing brief only named worker lanes (Issue #33).

Git credentials are themselves routed by remote URL path, so a push to `Clarit-AI/*` never uses the KHAEntertainment token — but only once the right `gh`/`GH_CONFIG_DIR` is actually in scope for that process. Author identity for this folder is `Clarit AI <info@clarit.ai>`.

---

## Verification lane storage sandboxing

**Scope**: any lane — worker, QA, reviewer, or prototype — whose assignment runs the real `enigma` tool (not just its unit tests) against local state.

Two real locations must be sandboxed, not one:
- `ENIGMA_HOME` — Enigma's own config/secret-store directory (default `~/.config/enigma`): `index.json`, `audit.log`, `secrets.enc`, `enigma.key`.
- `CLAUDE_CONFIG_DIR` — the editor-side config `enigma install`/`enigma doctor` read and write (default `~/.claude`): `settings.json`.

Both variables must point at a lane-local temp directory before the tool runs. Sandboxing only one is not a lesser version of this rule, it is a different rule that doesn't hold: a brief that named only `CLAUDE_CONFIG_DIR` once let verification lanes run the real tool against the user's real `~/.config/enigma`, and five orphaned entries landed in the real index before anyone noticed (Issue #43). No secret *values* leaked in that incident — the index holds names and metadata only, which is ADR-001 holding even in a case nobody intended to test — but `set`/`import` also write to the OS keychain and, on some depository paths, to 1Password, and those writes outlive a temp-directory cleanup; they are not undone by deleting the worktree.

Every lane report states the end state of **both** real locations — `~/.config/enigma` and `~/.claude/settings.json` — normally by checksum, so a lead can confirm nothing leaked into them even when the lane's own sandbox worked as intended.

---

## Verification lane worktree isolation

**Scope**: any time two or more delegated lanes (typically a QA lane and a reviewer lane) are dispatched against the same change.

Two lanes must never be pointed at the same worktree. The mechanism: `git branch verify/<n>-<lane> <head>` to cut one throwaway branch per lane from the commit under test, then a separate `git worktree add` per lane checking out its own branch — because git refuses to check the same branch out into two worktrees at once, this forces one directory per lane rather than relying on lane authors to remember it. Each lane then has its own directory and its own branch; neither can see the other's probe files or fixture edits.

This isn't a formality: for several rounds, QA and review shared one worktree, wrote probe files into the same tree, found each other's leftovers, and one reviewer corrected a bug in the other lane's fixture without either lane knowing the other existed (Issue #36). Two lanes reading one directory are not two independent reads — they are one shared mutable directory with two writers.
