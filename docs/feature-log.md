# Feature Log

## Completed
- Project bootstrap: PRD, PROJECT_CONTEXT, docs, license (PR #1, merged 2026-09-15)
- Evals, `docs/SECURITY.md`, README rewrite, end-to-end verification (Issue #15) — v1 closing Issue. Adds `plugins/enigma/evals/` (`claude plugin eval` cases for request/reveal/read-guard), the threat-model doc, and a clarit-docs-voice README.

## Known Tech Debt
- `docs/feature-log.md` itself is out of date relative to merged PRs (only the bootstrap entry existed before Issue #15); backfilling the ~19 merged PRs since is out of this Issue's scope.
- `docs/api-contracts.md` §3 documents `enigma request`/`enigma reveal` as CLI commands; both are currently stubbed as "not yet implemented" in `src/cli/index.ts` (Issue #14 shipped the MCP tools and slash commands instead). The contract document and the code have drifted; worth a follow-up to either implement the CLI form or correct the document.
- Issue #43 (verification writing to the real `ENIGMA_HOME`) left residual state in the real `~/.config/enigma` on this machine from before Issue #15's session (empty `index.json`, but `audit.log`/`enigma.key`/`secrets.enc` persist). Not touched or cleaned up by this Issue; flagged for the Tech Lead.
