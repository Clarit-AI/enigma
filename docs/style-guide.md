# Style Guide

## Naming
- TypeScript: `camelCase` for values and functions, `PascalCase` for types and classes, `SCREAMING_SNAKE` only for secret names (the product's own canonical form).
- Files: `kebab-case.ts`. One module per concern; no `utils.ts` grab-bags.
- Canonical domain words per `docs/glossary.md`: depository, prompt profile, scope, request, reveal. Never "backend", "vault", "destination".

## Directory Structure
```
src/
  core/        naming, index-store, audit, config
  storage/     interfaces, detect, depositories/<id>.ts
  request/     one-time request/reveal store
  web/         server, router, network-policy, templates/*.html
  native/      macOS adapters (osascript, pbcopy)
  remote/      cloudflared, tailscale, qr
  mcp/         server, tools
  hooks/       session-start, read-guard, tripwire
  cli/         index, commands/*
test/
  unit/ integration/ security/
plugins/enigma/   plugin manifest, .mcp.json, hooks/, skills/, commands/, dist/
```

## Secret-handling conventions (enforced by review and the leak fence)
- A value may exist only inside `src/storage/**`, `src/request/**` (in flight), `src/web/**` request handlers (in flight), `src/native/**`, `src/hooks/tripwire.ts`, and `cli/commands/{run,get,reveal,move,import}`.
- Never log, throw, or return a value. Errors are `EnigmaError { code, message, name?, depository? }`.
- Never place a value in `argv`, a URL, an env var of the plugin's own process, or a temp file. Child processes receive values on stdin or in their own env (for `run`).
- Zero out `Buffer`s holding values after use where practical.

## Error handling
- Throw `EnigmaError` with a stable `code` (`E_NAME_INVALID`, `E_NOT_FOUND`, `E_EXISTS`, `E_DEPOSITORY_UNAVAILABLE`, `E_READ_FAILED`, `E_REQUEST_EXPIRED`, `E_REQUEST_USED`, …). CLI maps codes to exit 1; MCP maps to `isError: true` tool results; HTTP maps to status codes.
- Fail fast; no silent fallback between depositories.

## Process execution
- Only `execFile`/`spawn` with argv arrays, `timeout`, and `maxBuffer`. No `exec`, no shell strings.

## Tests
- vitest; mocks of `execFile` assert argv never contains the value under test.
- Every PR adds or updates tests for the acceptance criteria of its Issue.

## Commits and PRs
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`). One Issue per PR; PR body links `Closes #N`.
