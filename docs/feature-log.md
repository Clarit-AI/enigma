# Feature Log

## Completed

### `v0.3.3` — prepared 2026-10-02 (not yet tagged: `enigma--v0.3.3` is pushed only at release)

Fixes for credential prompts found in real use (a headless host never shows the web form; native dialogs for several names were confusing), and rendered copies that stay current.

- Render fan-out: `set`, `add --rotate`, `remove`, `move` and `import` now bring every worktree in the project that holds a rendered line for NAME to the new state (value updated, line added for a no-prompt store, or line stripped), one target at a time under that target's file lock. Guaranteed for sequential operations and for concurrent rotates of one name; races between different commands on one name can leave a rendered line stale or missing (never a lost stored value), recoverable with `enigma render`. See "Render fan-out: guarantees and limits" in `docs/api-contracts.md`; follow-ups #125 and #126 (Issue #108 / PR #124).

- `enigma_request` no longer ends with a bare `Request cancelled` when a client advertises URL-mode elicitation but declines, cancels, errors or never answers (a headless/stream-json host declines automatically, so the user was never shown a form). It returns `{ request_id, url, expiresAt }` with the LOCAL link, keeps the request open for `enigma_await`, and says it can be retried with `ui: "native"`. A remote tunnel is stopped on a definite non-delivery and its public link never reaches the tool result; on a timeout (a slow human) it is left alone. The 30 s acknowledgement timeout applies to `enigma_request` only (Issue #118 / PR #119).
- `ui: "native"` with several names: each dialog now names its credential and position ("2 of 3", in the prompt and the title), asks for only that value, says the others follow (the last says it is the last), and shows the shared reason after that, labelled as covering the whole request. A single name looks as before (Issue #117 / PR #120).

### `v0.3.2` — shipped 2026-09-28 as `enigma--v0.3.2` (PR #103)

Read-guard and PATH-shim corrections found after the first shim release.

- Read-guard checks the child of `enigma run [flags] -- <child>` (and the
  bundled `node …/cli.mjs run` form the denial text recommends) through the
  same per-segment rules as a top-level segment, so `enigma run -- printenv X`
  is denied like `printenv X` (PR #95 / Issue #92, 2026-09-28). `sh -c` /
  `bash -c` is not unwrapped, with or without `enigma run`.
- PATH shim fixes (PR #98 / Issue #94, 2026-09-28): `enigma_doctor` no longer
  reports `enigma` on PATH when the shim is disabled or unavailable; a working
  link to a strictly older Enigma plugin bundle is re-pointed (semver
  precedence, prereleases included), while same-version, newer or unrelated
  targets report occupied; directories writable by the world are never shim
  locations; realpaths are compared so a symlinked plugin root still counts as
  present; read-only doctor reports a distinct `stale` status.
- Read-guard follow-ups from #95: the bundled-CLI form is
  recognised by a `node … cli.mjs run -- <child>` token pattern, so node
  options that take a separate value cannot hide it and no filesystem or
  manifest check is involved; leading `NAME=value`, `time` and `command` are
  skipped before the command head at top level and on the `enigma run` child
  (PR #100 / Issue #96, 2026-09-28).
- Build version embedded in every bundle (`ENIGMA_VERSION`, `src/core/version.ts`,
  an esbuild define mirrored in `vitest.config.ts`), so the stale-link check
  can compare against the running bundle in the npm-bin layout, which has no
  `plugin.json` beside `dist/cli.mjs`. The linked old target still needs a
  readable Enigma manifest: a manifest-less linked target is left `occupied`
  (see the known limit in `docs/architecture.md`). The MCP server constructor
  uses the same constant instead of a hardcoded string that two release bumps
  had missed. Session-start and
  read-guard tests now control `CLAUDE_PLUGIN_ROOT` instead of inheriting the
  ambient value, and the shim docs record the re-point, group-write and ACL
  rules (PR #101 / Issue #99, 2026-09-28).
- Release: version bump across all manifests and `dist/` (PR #103 / Issue #102,
  2026-09-28). The `package-lock.json` root versions had drifted at `0.3.0` and
  were corrected. Docs loop closed in the same PR: PATH-shim replacement rule
  and its no-manifest limit in `docs/architecture.md`.

### `v0.3.1` — shipped 2026-09-26 as `enigma--v0.3.1`

Put `enigma` on `PATH` after a marketplace install (Issue #90). The release
branch landed on `main` via PR #93 on 2026-09-28.

- The SessionStart hook symlinks the bundled CLI into a directory already on
  `PATH`, so the `enigma run -- <command>` form read-guard recommends is
  runnable after the only supported install. Absolute `PATH` entries only, the
  whole `PATH` is scanned before a new link is created so a working `enigma`
  is reported rather than shadowed, only a dangling link is re-pointed,
  `ENIGMA_NO_PATH_SHIM=1` opts out, and `ensureCliShim` never throws. `enigma doctor` reports the state read-only.
- Both bundles gate their entrypoint with `isMainModule()`
  (`src/core/is-main-module.ts`, `realpathSync` on both sides): the old
  `import.meta.url` comparison made the CLI a silent no-op when invoked
  through any symlink.

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
