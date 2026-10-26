# Rendering into `.env`

Some apps read their secrets from a `.env` file rather than from `enigma run`. `enigma render` writes this worktree's project-scope secrets into a managed `# enigma:render:begin` / `# enigma:render:end` block in that file. Every line outside the block is left byte-identical.

- **Plain `enigma render`** writes every project secret held in a no-prompt depository (`env` or `encrypted`). Secrets in prompting stores (Keychain, secret-service, 1Password) are never rendered automatically the first time; `enigma render NAME` renders one explicitly.
- **Kept current automatically.** Once a name is rendered, `add`, `remove`, `move`, `import` and the request form update its rendered line for you, without a separate `enigma render`.
- **Configuration** lives under `render` in `.enigma.json`: `enabled` (default on), `path` (default `.env`) and an optional `names` list to narrow what gets rendered. Global-scope secrets are never rendered.

The full rules (damaged blocks, symlinks, failure semantics, the file lock, the render ledger and the fan-out guarantees) are in [`api-contracts.md`](api-contracts.md), and the design reasoning is in [`architecture.md`](architecture.md).

Rendered values are plaintext on disk in that worktree's file, so the same trust level as any other `.env` applies. The read-guard still denies the agent's direct reads of it (see [hooks.md](hooks.md)).
