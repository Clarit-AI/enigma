# Tech Stack

## Language & Runtime
- Node.js 20+ (`engines` enforced), TypeScript 5 strict, ESM only (`"type": "module"`).
- No native modules. Every OS integration is a child process (`execFile` with argv arrays; values on stdin, never argv).

## Build
- esbuild bundles three entrypoints to single files with dependencies inlined: `plugins/enigma/dist/mcp-server.mjs`, `dist/hooks.mjs`, `dist/cli.mjs`. Built artifacts are committed per release so a marketplace install needs no `npm install`.
- HTML templates under `src/web/templates/*.html` are bundled as text (esbuild `loader: { ".html": "text" }`).

## Runtime dependencies (bundled)
- `@modelcontextprotocol/sdk` — MCP server, elicitation
- `zod` — tool input schemas
- a small QR encoder (e.g. `qrcode-generator`) — QR on the local page
- Nothing else. HTTP uses `node:http`; crypto uses `node:crypto`.

## Dev dependencies
- `typescript`, `esbuild`, `vitest`, `eslint` + `typescript-eslint`, `@types/node`

## Test Framework
- vitest. Layout: `test/unit`, `test/integration`, `test/security` (static leak fence).
- OS integrations are tested with a mocked `execFile` that asserts argv never contains a value; real-OS smoke tests are opt-in (`ENIGMA_E2E=1`).

## External tools (detected at runtime, never required)
- macOS: `/usr/bin/security`, `osascript`, `pbcopy`
- Linux: `secret-tool`
- 1Password CLI `op` ≥ 2.x
- `cloudflared`, `tailscale`

## Plugin host
- Claude Code ≥ 2.1.76 for MCP URL-mode elicitation; older clients use the `enigma_await` fallback.
