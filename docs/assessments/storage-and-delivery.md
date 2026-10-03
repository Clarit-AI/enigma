# Enigma: storage and delivery assessment

This is an independent assessment of how Enigma gets a secret from where it rests to the process that needs it. It checks the "Current secret pipelines" map against the code, then answers one question: should the choice of depository keep deciding both where a value rests and how it can be delivered?

Every citation is to `main` at `17d96d4` (v0.3.0). Some things are settled and are not reopened here: ADR-001 (no value enters the model's context window), the threat model in [`docs/SECURITY.md`](../SECURITY.md), and the distribution fix that puts `enigma` on `PATH`. That fix is referenced only where another design depends on it.

## Verdict

- **The storage/delivery coupling is incidental, not structural.** The `Depository` interface is storage only: `set`, `resolve`, `delete`, `has` ([`src/storage/interfaces.ts:21-53`](../../src/storage/interfaces.ts)). `enigma run` has no depository-specific logic ([`src/cli/commands/run.ts:80-86`](../../src/cli/commands/run.ts)). The coupling users feel comes from `env` being the one depository whose storage medium is also a delivery medium: the app's own dotenv loader reads it. Nothing else has a file-shaped delivery path, so "store in the Keychain, deliver as `.env`" cannot be expressed.
- **The real structural gap is the scope model.** The index has one slot per (name, scope, repository). The `env` depository needs one slot per worktree. The code turns that mismatch into observable breakage (see [the scope-model gap](#the-scope-model-gap-worked-through)).
- **Build delivery as its own layer, in two cheap steps, and defer the expensive one.**
  - Design A (exec-wrap) covers four of the five launch paths with no new plaintext.
  - Design B (render a regenerable `.env` from an authoritative depository) covers the rest, at the cost of plaintext at rest.
  - Design C (resident broker with named-pipe mounts) is the only design that removes plaintext at rest for launch paths Enigma does not exec. It is also the most expensive, and it carries named-pipe failure modes that land on exactly the owner's main case: a dev server that watches `.env`.
- **One existing read-guard gap becomes reachable the day the PATH fix ships.** `enigma run -- printenv NAME` is allowed today and prints the value into the session. Close it in the same release.

## Corrections to the pipeline map

I checked every anchor in the map against the code. The line numbers are all correct. These claims are not:

1. **§1, lock order.** The map says `setSecret()` "takes the index lock, writes to the depository, then commits the index entry." The depository write happens first and outside the lock ([`src/storage/manager.ts:167`](../../src/storage/manager.ts)). Only the index commit runs under the lock (`mutateIndex`, [`manager.ts:212`](../../src/storage/manager.ts)). ADR-003 states this on purpose: slow depository I/O stays outside the lock. The order matters for any new delivery layer, for two reasons. It is why a concurrent `set` can orphan a value (the comment at `manager.ts:216-221`). And it is why the `secrets.enc` read-modify-write has no exclusion at all (Issue #87).
2. **§3, the read table misses a materialization path.** `enigma move NAME --to env` is agent-invocable (the read-guard does not deny `move`) and writes the value into the worktree's `.env`. It is the only existing way to get from `encrypted` to an app-readable file. But it *moves*: the source copy is deleted and the index is re-pointed. So it cannot express "rest here, deliver there."
3. **§3, an unaudited read site.** `manager.ts:187` calls `Depository.resolve()` directly during a same-depository rotate, which bypasses `resolveSecret()`'s audit line. The map lists the line but not the bypass. ADR-001 and `docs/SECURITY.md` both enumerate "five sites plus the tripwire" and omit it. This is an accuracy gap in those two documents, not a flaw in ADR-001.
4. **§3/§4, `enigma run` output reaches the session.** The map calls `enigma run` "the sanctioned path." It is, but the child's stdout comes back to the agent. The read-guard's `enigma` rule matches only `get` and `env` as the subcommand ([`src/hooks/read-guard.ts:568-571`](../../src/hooks/read-guard.ts)). The env-dump rule matches only a bare `env`/`printenv` head (`read-guard.ts:563-566`). Checked against the built hook:

   ```bash
   echo '{"tool_name":"Bash","tool_input":{"command":"enigma run -- printenv OPENAI_API_KEY"},"cwd":"/tmp"}' \
     | ENIGMA_HOME=/tmp/scratch node plugins/enigma/dist/hooks.mjs PreToolUse
   # no output: allowed
   ```

   Bare `printenv OPENAI_API_KEY` is denied. PRD acceptance scenario S4.1 says the `enigma run` form "via the agent's Bash tool is denied." It is not. The tripwire would warn afterwards, but the value is already in context by then. This is an accidental-read shape (an agent checking "is the key set?"), so it falls inside the stated threat model.
5. **§5, launchd and supervisors are not "Nothing."** A launchd `ProgramArguments` of `enigma run -- <cmd>` with a `WorkingDirectory`, or a supervisord `command=` line, works mechanically today. `run` resolves scope from `process.cwd()` ([`run.ts:79`](../../src/cli/commands/run.ts)). What is missing is a stable absolute path to the binary, plus a depository whose prompt profile is `none`. Relatedly, `enigma run -- docker compose up` reaches containers only through `environment:` passthrough or `${VAR}` interpolation. A service using `env_file: .env` reads the file, not the process environment.
6. **Minor.** §2 says the other four depositories have no identity/location split. `1password` also consumes the lexical `findProjectPath` for its item title ([`interfaces.ts:57-64`](../../src/storage/interfaces.ts)), though it is cosmetic because reads go by item id. And [`docs/glossary.md`](../glossary.md) still defines **project** as "the git repository root's absolute path." Since Issue #67, the code has two notions (identity and location) sharing one word, which is the scope-model gap in vocabulary form.
7. **Minor, doc precision.** `docs/SECURITY.md` and [`docs/style-guide.md:28`](../style-guide.md) say a value is never placed in a temp file. [`src/storage/import-commit.ts:42-45`](../../src/storage/import-commit.ts) writes the whole rewritten `.env` (plaintext included) to a same-directory temp file and renames it. That is a reasonable atomic write and accepted precedent, and Design B would rely on the same pattern. But the rule as written overstates the code.

## Which couplings are load-bearing

| Coupling | Verdict | Evidence |
| --- | --- | --- |
| Depository choice decides delivery | Incidental | Interface is storage only; `run` resolves any depository the same way |
| Project identity vs `env` file location | Load-bearing gap | One index slot per repo, one `.env` per worktree (below) |
| Delivery tied to an agent session | Not coupled | `enigma run` is a plain CLI. Entry is session-bound: the request server lives in the MCP process (D2.2) |
| Delivery tied to `cwd` | Incidental | Every launcher in scope can set a working directory |
| Delivery tied to `enigma` being on `PATH` | Incidental | The agreed distribution fix |
| Prompt profile paid at read time | Load-bearing | D1.2 and S1.3 promise a per-read cost; moving reads earlier changes that promise |
| No resident process | Load-bearing for cost | Keeps upgrades simple (Issue #66 already requires restarting every writer on a lock change). It is also why no named-pipe delivery is possible today |

Frictions #1 and #2 share one root cause. `encrypted` values have exactly one agent-facing delivery path, `enigma run`, and after a marketplace install that path needs a binary that is not on `PATH`. The read-guard's denial text points at the same binary (`USE_INSTEAD`, `read-guard.ts:166`). `env` "worked" because its delivery path is the app's own dotenv loader, which needs no Enigma binary at all.

Friction #4 has a sharper edge than the map shows. `enigma import` into any depository other than `env` removes the imported lines from `.env` and leaves a `# Moved to Enigma (...)` comment ([`import-commit.ts:247-251`](../../src/storage/import-commit.ts)). The secure path therefore actively takes away the app's own boot configuration, and leaves `enigma run` as the only way back.

### The scope-model gap, worked through

Issue #67 made `projectId` the repository identity: the realpath of the common git dir, shared by every linked worktree ([`src/core/project.ts:169-224`](../../src/core/project.ts)). `findProjectPath` stayed lexical and returns the worktree root (`project.ts:17-25`). The `env` depository writes to `<findProjectPath(cwd)>/.env` (`manager.ts:112-114`, [`env.ts:128-138`](../../src/storage/depositories/env.ts)).

The index can record one `projectPath` per (name, `project`, `projectId`). So an `env` secret lives in exactly one worktree at a time, and the code plays that out as follows:

1. **Written from worktree A, used from worktree B.** `enigma run` in B resolves through the entry's recorded `projectPath` (`projectPathFor`, `manager.ts:45-48`) and reads `A/.env`. The app's own dotenv loader in B reads `B/.env` and finds nothing. The same secret works through one delivery path and fails through the other.
2. **Rotated from B.** The value lands in `B/.env`, and Issue #70's cleanup deletes the line from `A/.env`, because the canonical `projectPath` differs (`manager.ts:258-274`). A test pins this as intended: [`test/unit/storage/rotate-cleanup.test.ts:215`](../../test/unit/storage/rotate-cleanup.test.ts), "env rotate from worktree B over an entry recorded at A: value lands in B/.env, A/.env line removed." The app in A loses its secret.
3. **New worktree C.** There is no `.env` (it is gitignored), and `enigma_request` refuses with `E_EXISTS` because the name already exists at repository scope. Only a rotate helps, and a rotate breaks whichever worktree held it before.
4. **Worktree A deleted.** The entry becomes `orphaned-unrecoverable` for `enigma migrate-scope`, and the value is gone.

This matches friction #3's symptoms: the same secret entered repeatedly, and a new session breaking something that worked. The code cannot tell me which step the owner hit, but every step above is reachable from ordinary multi-worktree agent use.

No fix confined to the `env` depository is correct. If a rotate leaves A's line in place, A keeps an untracked plaintext copy that the index no longer knows about (so the tripwire no longer scans it). If it removes the line, A breaks. The underlying fact is that *where a value is delivered* has a different cardinality (per worktree) from *whose value it is* (per repository). The fix is a second axis in the model, not a better `env` depository. Designs B and C both add that axis.

## Security aspects that must hold

The owner's bar is explicitly not zero. These are the aspects that carry weight, stated so any design can be checked against them.

**Must hold:**

1. **ADR-001.** Any new command prints names only, and the read-guard covers every file path a design writes to. `.env` and `.env.*` are already denied (`isDotEnvBasename`, `read-guard.ts:168-171`, exempting `.env.example`), so a design that renders into `.env` or `.env.local` inherits the guard.
2. **An authoritative copy that is encrypted at rest and worktree-agnostic.** This is why `encrypted` was preferred, and it is the property the `env` depository cannot offer.
3. **A bound secret set.** Today `enigma run` without `--only` injects every visible project and global secret into every child ([`run.ts:14-25`](../../src/cli/commands/run.ts)). The committed manifest `.enigma.json` already declares which names a project needs ([`src/core/config.ts:13-16`](../../src/core/config.ts), D4.4). Any delivery (injection or file) should default to that set. It limits what one accidental print can expose.
4. **File mode `0600` and the gitignore check** on anything written into a worktree. Both exist today (`FILE_MODE`, `env.ts:8`; `checkEnvGitignore`, `env.ts:102`).
5. **Audit coverage of every materialization**, with the worktree it landed in. Then "which worktrees hold plaintext of `DATABASE_URL`?" has an answer.

**Honest limits, whichever design is chosen.** Nothing can audit reads of a plaintext file. Same-user processes can read a child's environment (`/proc/<pid>/environ`, `ps eww`), a rendered file, or a named pipe, and that is out of scope by the threat model.

**Negotiable, and the owner's call:**

- Plaintext at rest inside a worktree.
- Whether a `may-prompt` or `prompts-each-read` depository can be read once at render time instead of on every launch.

## Three designs

Five launch paths are in real use: an agent-run command, a bare terminal command, `docker compose up`, an IDE run or debug session, and a supervisor or launchd job. The table after the three designs compares their coverage.

### Design A: exec-wrap, with Enigma as the parent process

**Mechanism.** No new storage and no new files. Enigma becomes the parent process wherever the launcher lets it:

- **The agent** runs `enigma run -- <cmd>` once the PATH fix lands.
- **Terminal users** declare the wrapper once in the project (`"dev": "enigma run -- next dev"` in `package.json`, a `Makefile` target, a `justfile` recipe) and keep typing `npm run dev`.
- **`docker compose`** runs under `enigma run`, and services pass names through `environment: [DATABASE_URL]`.
- **launchd and supervisord** put `enigma run --` in `ProgramArguments` or `command=`.
- **VS Code, for Node,** sets `"runtimeExecutable"` to the Enigma shim with `"runtimeArgs": ["run", "--", "node"]`. `run` passes `process.env` through ([`run.ts:83`](../../src/cli/commands/run.ts)), so the debugger's own injected variables survive.

The common loaders (Node `dotenv`, Vite's `loadEnv`, `python-dotenv`) do not override a variable that is already set by default. So injection composes with an app that still calls `dotenv.config()` and has no `.env` present.

**Code changes.**

1. `enigma run` defaults to the manifest's declared names when `.enigma.json` has any. `--only` still narrows further, and no manifest means today's behavior. This touches `run.ts:14-25,80` and `loadProjectManifest` (`config.ts:36`). It narrows behavior for projects that have a manifest, so the owner may prefer it as an opt-in manifest key.
2. The read-guard treats `enigma run [flags] -- env|printenv ...` as an env dump (`read-guard.ts:151`, `563-566`).
3. One recipes page in `docs/`.

**Dependency on the PATH fix.** launchd plists, supervisord configs and IDE launch files store absolute paths. `${CLAUDE_PLUGIN_ROOT}` is defined only inside Claude Code, and the plugin cache path is not promised to be stable across updates. For Design A to reach those launchers, the PATH fix needs a stable absolute shim, not only a `PATH` entry scoped to the agent's shell.

**Security posture.**

- Nothing new at rest.
- A value exists in the child's environment for the child's lifetime and nowhere else Enigma controls.
- Each launch writes one audited `read` line per injected name (`resolveSecret`, `manager.ts:363`).
- Prompt profiles apply per launch. `keychain` may prompt, and `1password` prompts on every launch, which is fine interactively and breaks an unattended launchd job. That is the existing S1.3 guidance, unchanged.

**Costs and failure modes.**

- Small to build.
- It does not help a tool that only reads a file: JetBrains run configurations, non-Node IDE debuggers, and GUI apps launched from the Dock (which do not inherit a shell environment).
- The terminal case still means editing a script once per project.

### Design B: render, where the depository is authoritative and the worktree file is a build artifact

**Mechanism.** A new command, `enigma render` (name open), resolves the project's declared names from whatever depository holds each one. It writes them into a managed block in a file in the current worktree, `.env` by default, at `0600` via temp-file-plus-rename. This is 1Password's `op inject` model, applied to Enigma's index.

- **Binding (per repository, committed).** `.enigma.json` gains `"render": { "path": ".env" }`. The names default to the manifest's `secrets` keys, and an optional `"names"` list narrows them. Because the manifest is committed, every worktree agrees on what to render.
- **Ledger (per worktree, names only).** A new file in `~/.config/enigma/` records each render: `projectId`, worktree path, file, names, and time. The per-worktree cardinality lives here, not in the index. That is the second axis the scope-model gap needs.
- **Source of truth.** The depository is authoritative. Enigma never reads the rendered file back: `resolve` never touches it, and `render` never parses values out of it. Edits inside the block are overwritten on the next render, and edits outside it are preserved. The block uses its own markers (for example `# enigma:render:begin`) so that it never collides with a legacy `env` depository block in the same file.
- **Lifecycle.**
  - A rotate re-renders every ledger target that holds the name. Like Issue #70's cleanup, it is best-effort and warns on failure.
  - `remove` strips the name from every target.
  - `doctor` lists targets and prunes those whose worktree is gone.
- **Triggers.**
  1. **Explicit `enigma render`,** by a human or the agent. It prints names only.
  2. **SessionStart,** when the manifest opts in. It renders only names held in a `none`-profile depository into the session's worktree, and reports the rest by name. SessionStart fires for every new agent session in every new worktree, which is exactly where friction #3 bit. Its stdout stays names-only, and a sentinel test must prove that.
  3. **An opt-in git `post-checkout` hook,** so that `git worktree add` renders with no agent involved. Caveat: hooks live in the common git dir, and repositories using husky or lefthook own `core.hooksPath`, so install must detect conflicts and refuse to clobber.
- **The `env` depository** stays for compatibility. The picker relabels it "plaintext, this worktree only," and `doctor` suggests `enigma move NAME --to encrypted` followed by adding the name to `render`. New usage never needs it.

**Security posture, stated plainly.**

- Plaintext rests in every rendered worktree, at `0600`, with the gitignore check. That is the same *kind* of exposure as today's `env` depository.
- What changes:
  - The file is never the only copy, so deleting a worktree loses nothing.
  - Only declared names land in it.
  - Every render is audited with its worktree path.
  - A rotate reaches every rendered copy.
- What it does not do:
  - Audit reads of the file.
  - Keep the file out of backups, Spotlight, or a cloud-synced folder.
- Design B relocates the plaintext (in fact, one copy per rendered worktree). It does not relocate the source of truth, and that split is the point. The staleness and worktree problems that made `encrypted` preferable go away; the at-rest exposure does not.
- **Prompt profile.** Rendering a `keychain` or `1password` value reads it once and then leaves it available without prompts until the next render. That relaxes D1.2's per-read contract for those names. `render` should refuse `prompts-each-read` depositories unless the manifest or a flag says otherwise, and that decision belongs to the owner.

**Costs.** Medium:

- A command, a manifest key and a ledger file.
- Fan-out on rotate and remove.
- A `doctor` section.
- A SessionStart write path. Today SessionStart never resolves a value; only the tripwire does ([`src/hooks/tripwire.ts:92`](../../src/hooks/tripwire.ts)).
- A per-target write lock, because rendering is a read-modify-write of a file other tools also edit. That is the same class of problem as Issue #87.
- The style guide's temp-file rule needs the same stated exception `import-commit.ts` already relies on.

### Design C: a resident broker with named-pipe mounts

**Mechanism.** `enigma broker` runs as a per-user LaunchAgent (macOS) or systemd user unit (Linux).

- It owns decryption and listens on a `0600` Unix socket under `~/.config/enigma/`.
- For each render target it creates a named pipe (FIFO) instead of a file. When a process opens the pipe, the broker writes the rendered block and closes it.
- It watches `<common git dir>/worktrees/` and mounts new worktrees automatically, with no git hook and no agent session.
- `enigma run` becomes a client that asks the broker for the bound set. It must keep a direct-decrypt fallback for when the broker is down, which means two code paths.

This is the 1Password Environments model.

**What it buys.**

- No plaintext at rest for launch paths Enigma does not exec.
- Delivery with no command to remember and no agent session.
- One process that holds the prompts.
- Each open of a mount can be audited, though not *who* opened it: a FIFO carries no peer identity. The socket can check the peer's uid, but not which binary is calling.

**Costs.**

- **Install.** The marketplace has no postinstall step (D5.2), so the user runs `enigma service install` once, and uninstall must remove the unit. The unit must point at the stable shim, not the version-scoped plugin cache.
- **Upgrades.** A long-running process keeps old code. Issue #66 already requires restarting every Enigma writer on a lock-protocol change. With a broker, every upgrade carries that step.
- **A value-serving socket is `enigma get` over a different transport.** Any same-user process can ask for values. The read-guard would need to deny obvious socket clients, and deliberate evasion stays out of scope. This is an availability feature, not a security gain.
- **Named-pipe semantics.** These are documented from 1Password's own feature:
  - A pipe has one reader at a time, so a dev server, its file watcher and the IDE opening `.env` race, and one of them gets nothing.
  - `stat` reports size 0.
  - Watchers never see a change.
  - A tool that opens the file without reading it blocks the writer.
  - There is no Windows support.
  - A container that bind-mounts the pipe can hang (OrbStack issue #2227).
  - A dev server that watches `.env` (Next.js, Vite) is likely the owner's main case, and it is the case these hazards hit.
- **Code size.** The largest of the three: per-OS service management, a socket protocol, the mount lifecycle, and crash recovery (a pipe left behind by a dead broker reads as empty or hangs).

**Verdict.** Design C is the only design that removes plaintext at rest for the IDE and for apps that load `.env` themselves. Do not build it yet. Design B's manifest binding and ledger are exactly the mount table C would need, so building B first throws nothing away.

### Coverage side by side

| Launch path | Today | A: exec-wrap | B: render | C: broker and pipes |
| --- | --- | --- | --- | --- |
| Agent runs a command | `enigma run`, blocked by `PATH` | Yes | Yes | Yes |
| Bare terminal | User types `enigma run` | Yes, declared once in a project script | Yes, the app reads `.env` | Yes |
| `docker compose up` | Via `run`, `environment:` passthrough only | Same | Yes, `env_file:` reads the rendered file on the host | Host read works; container bind-mounts can hang |
| IDE run or debug | Nothing | Partial: Node via `runtimeExecutable` | Yes: `envFile` or the IDE's `.env` support | Yes, subject to single-reader races |
| Supervisor or launchd | Works mechanically, undocumented | Yes, with a stable shim and a `none`-profile depository | Yes, if the app loads `.env` from its working directory | Yes, if the broker starts first |
| Plaintext at rest | `env` depository only | None added | One copy per rendered worktree | None |

## How 1Password handles the same problem

The owner asked how 1Password handles these same caveats. Its developer tooling separates the two concerns completely: a vault item is storage, and delivery is chosen per use rather than per item. It offers three delivery modes, and they line up with the three designs above.

- **`op run --env-file=<file> -- <cmd>`.** The file holds `op://vault/item/field` references, not values, and `op run` resolves them into the child's environment for one command. This is Design A. Enigma's `.enigma.json` already plays the reference-file role for names, though it has no renaming.
- **`op inject -i <template> -o <file>`.** It renders a template to a file, and 1Password's own guidance notes that the output leaves secrets on disk. This is Design B. 1Password accepts that posture for tools that only read files.
- **1Password Environments, local `.env` file.**
  - 1Password mounts a UNIX named pipe at the chosen path, and the desktop app serves the contents to the reading process on demand, so nothing lands on disk.
  - The first read triggers authorization, which lasts until 1Password locks. During that window 1Password does not distinguish processes, so every process running as the user can read the mount.
  - Mac and Linux only; one reader at a time.
  - This is Design C, and it depends on 1Password's resident desktop app.
- **Agent hooks.** [`1Password/agent-hooks`](https://github.com/1Password/agent-hooks) ships one hook, `1password-validate-mounted-env-files`, for Cursor, Claude Code, GitHub Copilot and Windsurf. Before the agent runs a shell command, it checks that the configured mount paths exist, are enabled and are valid FIFOs, and denies the command when they are not. It does not stop the agent from reading the mount.

Three lessons carry over:

1. **No 1Password item "is" an env file.** Storage and delivery are separate products, which is the separation this assessment recommends.
2. **1Password offers all three postures because none of them dominates.** The plaintext of `op inject` is a deliberate option, not an oversight.
3. **The pipe model needs a resident process and a trust window,** and in 1Password's stack the agent is kept from reading `.env` by nothing but its own restraint. Enigma's read-guard already denies `.env` reads. That makes Enigma's Designs B and C stronger against accidental agent reads than their 1Password equivalents.

**Source caveat.** The 1Password documentation and blog domains were unreachable from the environment that produced this assessment. The GitHub README above was read directly. The rest comes from search summaries of the pages listed under [Sources](#sources), and should be checked against them before anyone quotes 1Password's behavior as fact.

## What to sequence first

0. **The PATH fix (separate and agreed).** One input from this assessment: it should produce a stable absolute path, not only a `PATH` entry inside the agent's shell, because Design A's launchd, supervisord and IDE recipes store absolute paths.
1. **In the same release, deny `enigma run ... -- env|printenv` in the read-guard, and correct PRD S4.1.** The PATH fix is what makes this command reachable, and it is the first thing an agent types when it checks whether a key is set.
2. **Design A.** A manifest-bound `run`, plus a recipes page. It covers four launch paths with no new plaintext, and it is small.
3. **Design B.** `render`, the ledger, the opt-in SessionStart trigger, and demoting `env` in the picker. It covers the IDE and new worktrees, and it removes the cross-worktree hazard for new usage.
4. **Revisit Design C after Design B has run on real projects,** and only if plaintext at rest in worktrees turns out to be the cost the owner wants removed. Evidence to collect first: whether rendered files end up in backups or synced folders, and whether prompting at render time is acceptable.

Separately, correct the documentation findings above: ADR-001's enumeration of read sites, the temp-file rule in `docs/SECURITY.md` and the style guide, and the glossary's definition of **project**.

## What I would not build

- **An `enigma_run` MCP tool.** It would put a value-resolving path under `src/mcp/**`, which the leak fence exists to forbid. It would block the tool call for as long as a dev server runs. And the PATH fix delivers the same capability more cheaply.
- **Values written to `CLAUDE_ENV_FILE` or exported into the agent's shell.** Every Bash call would inherit every secret, and ADR-004 declines this for that reason ([`src/hooks/session-start.ts:3`](../../src/hooks/session-start.ts)).
- **A direnv-style `eval "$(enigma export)"` hook.** It is a bulk `enigma get` on stdout that the read-guard would have to chase, and the agent's Bash tool does not run interactive shell hooks, so it does not help the agent anyway.
- **In-process language loaders** (`node -r enigma/register` and similar). They are per-language and change the application being built, which is outside Enigma's job.
- **A bidirectional `.env`** that reads edits back into the depository. Two writable copies bring back the source-of-truth ambiguity that Design B exists to remove.
- **An encrypted-`.env` scheme** where the app decrypts at boot. The app then needs a decrypt step and a key in its environment, which is `enigma run` with extra parts.
- **Cloud-sync delivery** to hosting providers. Enigma is a local development tool.
- **A broker that caches decrypted values** to skip 1Password prompts. It silently changes the prompt-profile contract. If Design C is ever built, caching is a separate owner decision.
- **A named pipe without a broker.** It cannot work: something must be alive to write when the app opens the file.

## The five audit questions, answered

1. **Should storage and delivery be separable?** Yes, and they already are in the interface. What is missing is delivery primitives that take a name and resolve it from whichever depository holds it: injection (Design A) and a rendered file (Design B). See [Which couplings are load-bearing](#which-couplings-are-load-bearing).
2. **Is the `env` location mismatch a depository problem or a scope-model problem?** A scope-model problem. The index has one slot per repository and the file needs one per worktree. The rotate test at `rotate-cleanup.test.ts:215` shows the consequence, and no depository-only fix is correct. See [the scope-model gap](#the-scope-model-gap-worked-through).
3. **What is the smallest change that makes a delivery path exist at all?** The PATH fix. Ship the `enigma run -- printenv` guard fix with it, because that fix makes the gap reachable. `enigma move --to env` exists as a stopgap today, but it moves the value instead of delivering it.
4. **What primitive covers a process Enigma does not exec?** A file at a path the tool already reads. There are exactly two ways to back it: a plaintext render (Design B) or a named pipe served by a resident process (Design C). Design A shrinks this set by turning launchd jobs, compose and project scripts into processes Enigma does exec. What remains is the IDE, and apps that load `.env` themselves.
5. **What changes if there is a resident process?** It makes plaintext-free file delivery possible, along with automatic mounting of new worktrees and centralized prompting. It costs a service install, a restart on every upgrade, a value-serving socket no stronger than `enigma get`, two code paths for `run`, and named-pipe failure modes on concurrent readers. See [Design C](#design-c-a-resident-broker-with-named-pipe-mounts).

ADR-001 and the threat model need no revisiting for any of the above.

## Sources

- [`1Password/agent-hooks`](https://github.com/1Password/agent-hooks) and its [`1password-validate-mounted-env-files` README](https://github.com/1Password/agent-hooks/blob/main/hooks/1password-validate-mounted-env-files/README.md) (read directly)
- [Access secrets from 1Password through local .env files](https://www.1password.dev/environments/local-env-file) (1Password Developer)
- [Secure secrets for AI agents and tools](https://www.1password.dev/get-started/secure-ai-access) (1Password Developer)
- [Introducing new .env file support in 1Password environments](https://1password.com/blog/1password-environments-env-files-public-beta) (1Password blog)
- [A deep dive into 1Password Developer Environments](https://flaviocopes.com/1password-environments/) (single-reader and authorization-window details)
- [Reading a 1Password .env file from within a container hangs](https://github.com/orbstack/orbstack/issues/2227) (OrbStack issue #2227)
- [op run](https://nshipster.com/1password-cli/) (NSHipster, on `op run` and `op inject`)
