# Glossary

> Canonical domain terminology locked during Phase 1 word-precision.
> The main conversation and all Phases must use the canonical terms; do not use the near-synonyms listed under _Avoid_.

## Terms

**secret**: a named value (API key, token, password, connection string) that must never enter the agent's context window.
_Avoid_: credential (except as the 1Password field name), key (ambiguous with encryption keys)

**depository**: the place a secret's value lives. One of `env`, `encrypted`, `keychain`, `secret-service`, `1password`.
_Avoid_: backend, destination, store, provider, vault

**prompt profile**: a depository's interaction cost on read: `none`, `may-prompt`, or `prompts-each-read`.
_Avoid_: friction level, auth level

**scope**: whether a secret belongs to one project (`project`) or to the user everywhere (`global`).
_Avoid_: level, namespace

**project**: identified by the git repository root's absolute path (cwd fallback); hashed to form the project scope id.
_Avoid_: workspace, repo (when meaning the scope key)

**index**: `~/.config/enigma/index.json`, the names-only registry of secrets and their depositories.
_Avoid_: manifest (reserved for the project `.enigma.json`), catalog

**request**: a one-time, time-limited invitation for the user to enter one or more secrets out of band.
_Avoid_: prompt (reserved for prompt profile), ask

**reveal**: a one-time, time-limited disclosure of a secret value to the user out of band.
_Avoid_: show, get, read (read is the internal resolve)

## Relations

- One project has many secrets; each secret lives in exactly one depository.
- A request may cover several secrets; a reveal covers exactly one.

## Flagged Ambiguities

- "destination" and "backend" were both used for the same concept — resolution: canonical term is **depository**.
- "vault" collides with 1Password's collection term — resolution: not used for Enigma's own storage; the encrypted file is `secrets.enc`.
