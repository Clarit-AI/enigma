# Enigma

Secure secret handling for Claude Code. Enigma lets a coding agent request, store, use, and reveal secrets without a secret ever entering the chat transcript or the model's context.

Status: pre-release. The product requirements are in [PRD.md](PRD.md); engineering context starts at [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md).

## How it works

- The agent calls an MCP tool such as `enigma_request` with secret **names** only.
- Claude Code opens a one-time local web form (or a native macOS dialog) through MCP URL-mode elicitation. You type the value there. It never crosses MCP or the chat.
- The value lands in the depository you choose: the project `.env`, an encrypted file, the macOS Keychain, Linux secret-service, or 1Password.
- `enigma run -- <command>` injects secrets into a child process. Hooks stop the agent from reading them back and warn if one leaks into tool output.

## Install

Coming with v1: Claude plugin marketplace (primary), `npx @clarit-ai/enigma install`, or a GitHub checkout for development.

## License

Apache-2.0. See [LICENSE](LICENSE).
