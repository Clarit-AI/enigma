# Releasing Enigma

Enigma ships through two independent channels that share a version number but
release on different triggers. A release does **not** require doing both at
once — bump versions together, but tag each channel separately.

| Channel | Consumers use | Tag format | Triggers |
|---|---|---|---|
| Plugin (marketplace) | `claude plugin marketplace add Clarit-AI/enigma` + `claude plugin install enigma` | `enigma--v<version>` (`claude plugin tag` decides this) | Nothing in CI — marketplace installs read straight from the git repo/tag, no Action involved |
| npm package (`@clarit.ai/enigma`) | `npx @clarit.ai/enigma install` | `v<version>` | `.github/workflows/release.yml` |

Because `claude plugin tag`'s tag name always starts with `enigma--v`, not `v`,
it never collides with the npm workflow's `v*` trigger. That's intentional,
not an oversight — publishing an npm package doesn't require a marketplace
consumer to update, and cutting a plugin tag doesn't require an npm publish.

## 0. Before either release

1. Bump the version in **both** `package.json` and `plugins/enigma/.claude-plugin/plugin.json`
   and `.claude-plugin/marketplace.json`'s `plugins[0].version` (and
   `metadata.version`) to the same value. `claude plugin tag` validates that
   `plugin.json` and its marketplace entry agree — it refuses to tag if they
   don't.
2. Run `npm run build` and commit the result. `plugins/enigma/dist/*.mjs` is
   committed per release (ADR-006) — both channels ship the pre-bundled
   output, never a build step on the consumer's machine. CI (`ci.yml`) and
   the release workflow both fail the build if `dist/` doesn't match its
   committed source, so this step is not optional.
3. Commit everything. Both `claude plugin tag` and the release workflow's
   drift check require a clean tree / a tag that points at what's actually
   committed.

## 1. Plugin release (marketplace)

```bash
claude plugin tag --dry-run plugins/enigma   # sanity check first
claude plugin tag --push plugins/enigma      # creates + pushes enigma--v<version>
```

This validates `plugin.json` against the enclosing marketplace entry, creates
an annotated `enigma--v<version>` tag at `HEAD`, and (with `--push`) pushes it
to `origin`. No GitHub Action runs for this — a marketplace consumer's
`claude plugin install enigma@clarit-enigma` (or `claude plugin update`)
fetches directly from the tagged commit. This is also why AC5 ("marketplace
install works with no `npm install` step") holds: the plugin directory a
consumer gets is exactly `plugins/enigma/{commands,skills,hooks,dist,.mcp.json,.claude-plugin}`
— pre-bundled, self-contained `.mjs` files with every dependency inlined by
esbuild, nothing to `npm install`. This was verified manually for this PR:
`claude plugin marketplace add <this repo>` → `claude plugin install
enigma@clarit-enigma` → the installed copy under
`~/.claude/plugins/cache/clarit-enigma/enigma/<version>/` has no
`node_modules` anywhere in it, and running `plugins/enigma/dist/cli.mjs`
copied into an empty directory with no `node_modules` reachable works
unmodified.

## 2. npm release

```bash
git tag v<version>
git push origin v<version>
```

Pushing a `v*` tag runs `.github/workflows/release.yml`: full gate (lint,
typecheck, test, leak-fence, build, `npm audit`), a hard check that
`plugins/enigma/dist` matches what's committed (mirrors `ci.yml`'s own
check — if it fails, the message says exactly that: dist is stale, rebuild
and commit before tagging), and then `npm publish --provenance
--access public`.

**The publish step is now a live publish via npm trusted publishing (OIDC),
not a dry run.** It will FAIL (not silently skip) until the npmjs.com
trusted-publishing link is configured — see the "Trusted publishing
prerequisite" section below. The OIDC token comes from the workflow's
`id-token: write` permission, so no `NPM_TOKEN` repository secret is
required.

### Trusted publishing prerequisite (required before the first real publish)

On npmjs.com, open the `@clarit.ai/enigma` package → Access → Trusted
publishing → add owner `Clarit-AI`, repository `enigma`, workflow path
`.github/workflows/release.yml`, environment unset. `id-token: write` is
already declared in the workflow and no `NPM_TOKEN` secret is used — the
OIDC token supplies authentication for `npm publish --provenance`.
