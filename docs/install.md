# Install

The plugin marketplace is the only supported install path. Enigma targets Claude Code today.

## 1. Claude plugin marketplace (primary)

```bash
claude plugin marketplace add Clarit-AI/enigma
claude plugin install enigma@clarit-enigma
```

(Or the equivalent `/plugin` menu inside an interactive Claude Code session.)

## 2. GitHub checkout, for development on Enigma itself

```bash
git clone https://github.com/Clarit-AI/enigma.git
cd enigma && npm ci && npm run build
claude plugin marketplace add ./
claude plugin install enigma@clarit-enigma
```

This registers your checkout itself as a local marketplace source, so rebuilding `dist/` (`npm run build`) picks up changes without reinstalling.

## npm distribution is shelved for now

The `npx @clarit.ai/enigma install` method is on hold. The package has never been published, and the marketplace path above is the supported install method. It needs no npm registry access. [`RELEASING.md`](../RELEASING.md) records the status.

## How `enigma` gets on your `PATH`

Because there is no published package to run a `postinstall` from, the plugin puts `enigma` on your `PATH` itself: on your **first Claude Code session** after installing, Enigma creates one symlink in a directory that is already on your `PATH` and tells you so. Nothing else is touched. Your shell config is not edited, your `PATH` is not changed, and you have nothing to run yourself. Run `hash -r` if the shell needs to notice.

It is deliberately conservative: an existing `enigma` that already works is reported and left alone rather than shadowed, and only a broken symlink left behind by a plugin upgrade is repaired. `enigma doctor` reports the state at any time. To opt out entirely, set `ENIGMA_NO_PATH_SHIM=1`. If the shim cannot be placed at all, every command in these docs still works as `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" <command>`.

The design reasoning (why the shim lives in the `SessionStart` hook, which directories it will write to) is in ADR-006 of [`architecture.md`](architecture.md).
