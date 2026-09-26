# Feature Log

## Completed

### `v0.3.0` — shipped 2026-09-24 as `enigma--v0.3.0` (PR #86)

Repo-level project identity, durable index-write serialization, and the
request-lifecycle corrections. Plan of record: Traycer artifact `v0-3-0-plan`,
critiqued in `v0-3-0-plan-critique`; post-release resync in `v0-3-0-resync`.

- PROJECT_CONTEXT status/decisions/routing for the wave (PR #74, 2026-09-23).
- Recovery-signal correction for #62: drop the dead SessionStart recovery
  branch and report names from results rather than a fixed list (PR #75 /
  Issue #68, 2026-09-23).
- Repo-level project identity: `projectId` hashes the repository's canonical
  common git dir, so every worktree of one repo shares project scope (PR #76 /
  Issue #67, 2026-09-23). `findProjectPath` stays lexical for `projectPath`,
  the `env` depository `.env`, and the 1Password title folder.
- Serialize every index write with a kernel `flock(2)` descriptor lock on a
  persistent `index.lock` anchor, first-party N-API addon, with a short
  await-free critical section that re-reads the index (PR #77 / Issue #66,
  2026-09-23). Supersedes the `O_EXCL` + stale-threshold name-based protocol
  after review found its takeover window unsound. Upgrading requires stopping
  and restarting **all** Enigma writers — no mixed-protocol guarantee.
- Wake-on-submit: `GET /r/:id/status` state-only polling, no idle-out while a
  request is open, `E_OUTCOME_UNKNOWN` for a used record swept without results
  (PR #78 / Issue #69, 2026-09-23).
- `/enigma:remove` slash command wrapping the existing `enigma_remove` MCP tool
  (PR #81 / Issue #79, 2026-09-23).
- Extensible request form: server-side parsing of a pasted `.env` blob, plus a
  manual field. Unvalidated name text is counted, never echoed (PR #82 /
  Issue #71, 2026-09-23).
- Rotate replaces, then removes the old copy in the same depository; a failed
  cleanup warns and audits but does not fail the rotate (PR #83 / Issue #70,
  2026-09-24).
- `enigma migrate-scope`: explicit, index-only re-key of legacy project
  entries, dry run by default, surfaced through doctor / `enigma_doctor` /
  SessionStart. No read-time fallback (PR #84 / Issue #72, 2026-09-24).
- Project-scoped audit lines record `projectId`/`projectPath` so a `remove` or
  `leak` line is attributable when read from another project. Stays names-only,
  so ADR-001 is unaffected (PR #85 / Issue #80, 2026-09-24).
- Release: version bump across all manifests and the MCP server string
  (PR #86 / Issue #73, 2026-09-24), and the KHA Entertainment marketplace
  cross-listing pinned to `ref: enigma--v0.3.0`.

### Earlier

- Project bootstrap: PRD, PROJECT_CONTEXT, docs, license (PR #1, merged 2026-09-15)
- Evals, `docs/SECURITY.md`, README rewrite, end-to-end verification (Issue #15) — v1 closing Issue. Adds `plugins/enigma/evals/` (`claude plugin eval` cases for request/reveal/read-guard), the threat-model doc, and a clarit-docs-voice README.
- Documentation and process corrections (Issues #45, #43, #36, #33): `docs/api-contracts.md` §3 now matches the CLI's own `USAGE` string, including marking `enigma request`/`enigma reveal` as not implemented at the CLI rather than documenting them as working commands; `PROJECT_CONTEXT.md` gained explicit-scope rules for storage sandboxing (both `ENIGMA_HOME` and `CLAUDE_CONFIG_DIR`, not just one), worktree-per-lane isolation for verification lanes, and `GH_CONFIG_DIR` export for every delegated lane rather than worker lanes only.
- Read-guard rule taxonomy, comments/docs only, no behavior change (Issues #46, #48): `src/hooks/read-guard.ts`'s header comment now names the two structurally different rule shapes in the file (SCAN rules, which examine every token and are safe under over-splitting; HEAD rules, keyed to a fragment's first token(s), which are not — this is what made round 4's `echo ';' $NAME` bypass possible after three rounds where "more splitting, more denial" held), states the segmentation invariant `matchQuoteSpan`/`splitSegments` guarantee (a quote span that pairs successfully can never straddle a segment boundary, because the quote check runs before the separator check at every position) and why `tokenize` and `splitSegments` deliberately slice a matched span differently, and records two decisions as decisions rather than open gaps: a displaced head on `enigma get`/`security find-generic-password`/`op read` is not a functioning bypass because it corrupts the real CLI's own `argv[0]` dispatch too (verified against `src/cli/index.ts`), and backslash escaping outside `$'...'` remains an accepted, pre-existing gap. `docs/SECURITY.md` and `docs/api-contracts.md` §5 were checked against the updated comment and found still accurate; neither needed a change.

## Known Tech Debt
- **The encrypted depository has its own unlocked `secrets.enc` read-modify-write path** (Issue [#87](https://github.com/Clarit-AI/enigma/issues/87)). Issue #66's `flock(2)` lock serializes index writes only; concurrent encrypted-value durability is not established. `set()` and `deleteIfUnchanged()` in `src/storage/depositories/encrypted.ts` read the whole vault, patch one entry, and write it back with no exclusion — two concurrent writers lose the earlier entry, while its name still lands in the locked index, leaving an entry that `resolve()` reports as `E_NOT_FOUND`. The index-lock tests prove index serialization, not vault durability, and neither #66 nor #70's same-reference rotation work covers this.
- **leak-fence fixtures are written into the real `src/` tree** (Issue [#88](https://github.com/Clarit-AI/enigma/issues/88)), which forces a cross-test name-based skip in `reason-field-surfaces.test.ts`'s walker. The race is mitigated rather than eliminated, and the same issue tracks the one MCP integration setup timeout seen across ten full parallel runs on PR #76. A later passing run does not disprove either. Kept as a separate follow-up from the repository-identity fix; no blanket parallelism disable or retry-to-green policy has been approved.
- `docs/feature-log.md` still has not backfilled the ~19 merged PRs between the bootstrap and Issue #15.
- ~~`docs/api-contracts.md` §3 documents `enigma request`/`enigma reveal` as CLI commands...~~ Fixed by Issue #45 (see Completed).
- Issue #43's residual state in the real `~/.config/enigma`: as of this PR, the real index (`~/.config/enigma/index.json`) is empty and the five orphaned entries reported in Issue #43 are gone; `audit.log`, `enigma.key`, and `secrets.enc` persist, holding no secret values (names/metadata and ciphertext only, per ADR-001). The standing gap that let it happen — a sandboxing brief that named only `CLAUDE_CONFIG_DIR` — is closed by the new "Verification lane storage sandboxing" rule in `PROJECT_CONTEXT.md`.
