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

This repository belongs to the `Clarit-AI` GitHub account. Every `gh` and `git` write in this project runs with `GH_CONFIG_DIR=/Users/bbrenner/.config/gh-clarit` (set via `.claude/settings.local.json`, and exported explicitly in every worker lane's assignment). Git credentials are routed by remote URL path, so a push to `Clarit-AI/*` never uses the KHAEntertainment token. Author identity for this folder is `Clarit AI <info@clarit.ai>`.
