# Feature Log

## Completed
- Project bootstrap: PRD, PROJECT_CONTEXT, docs, license (PR #1, merged 2026-09-15)
- Evals, `docs/SECURITY.md`, README rewrite, end-to-end verification (Issue #15) — v1 closing Issue. Adds `plugins/enigma/evals/` (`claude plugin eval` cases for request/reveal/read-guard), the threat-model doc, and a clarit-docs-voice README.
- Documentation and process corrections (Issues #45, #43, #36, #33): `docs/api-contracts.md` §3 now matches the CLI's own `USAGE` string, including marking `enigma request`/`enigma reveal` as not implemented at the CLI rather than documenting them as working commands; `PROJECT_CONTEXT.md` gained explicit-scope rules for storage sandboxing (both `ENIGMA_HOME` and `CLAUDE_CONFIG_DIR`, not just one), worktree-per-lane isolation for verification lanes, and `GH_CONFIG_DIR` export for every delegated lane rather than worker lanes only.

## Known Tech Debt
- `docs/feature-log.md` itself is out of date relative to merged PRs (only the bootstrap entry existed before Issue #15); backfilling the ~19 merged PRs since is out of this Issue's scope.
- ~~`docs/api-contracts.md` §3 documents `enigma request`/`enigma reveal` as CLI commands...~~ Fixed by Issue #45 (see Completed).
- Issue #43's residual state in the real `~/.config/enigma`: as of this PR, the real index (`~/.config/enigma/index.json`) is empty and the five orphaned entries reported in Issue #43 are gone; `audit.log`, `enigma.key`, and `secrets.enc` persist, holding no secret values (names/metadata and ciphertext only, per ADR-001). The standing gap that let it happen — a sandboxing brief that named only `CLAUDE_CONFIG_DIR` — is closed by the new "Verification lane storage sandboxing" rule in `PROJECT_CONTEXT.md`.
