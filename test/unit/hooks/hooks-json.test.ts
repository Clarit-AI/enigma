import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const HOOKS_JSON_PATH = join(REPO_ROOT, 'plugins/enigma/hooks/hooks.json');

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

interface HooksManifest {
  hooks: {
    SessionStart: HookEntry[];
    PreToolUse: HookEntry[];
    PostToolUse: HookEntry[];
  };
}

function readManifest(): HooksManifest {
  return JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf8')) as HooksManifest;
}

describe('plugins/enigma/hooks/hooks.json (AC6)', () => {
  it('routes all three events through the single bundled entrypoint', () => {
    const manifest = readManifest();
    for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse'] as const) {
      const commands = manifest.hooks[event].flatMap((entry) => entry.hooks.map((h) => h.command));
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('${CLAUDE_PLUGIN_ROOT}/dist/hooks.mjs');
      expect(commands[0]).toContain(event);
    }
  });

  it('PreToolUse matcher covers Read, Bash, Grep, and Glob', () => {
    const manifest = readManifest();
    const matcher = manifest.hooks.PreToolUse[0]?.matcher ?? '';
    const regex = new RegExp(`^(?:${matcher})$`);
    for (const tool of ['Read', 'Bash', 'Grep', 'Glob']) {
      expect(regex.test(tool)).toBe(true);
    }
  });

  it('PreToolUse matcher does not blanket-match every tool (e.g. Write, Edit, Task)', () => {
    const manifest = readManifest();
    const matcher = manifest.hooks.PreToolUse[0]?.matcher ?? '';
    const regex = new RegExp(`^(?:${matcher})$`);
    for (const tool of ['Write', 'Edit', 'Task']) {
      expect(regex.test(tool)).toBe(false);
    }
  });

  it('PostToolUse matcher covers Bash, Read, Grep, and any mcp__ tool', () => {
    const manifest = readManifest();
    const matcher = manifest.hooks.PostToolUse[0]?.matcher ?? '';
    const regex = new RegExp(`^(?:${matcher})$`);
    for (const tool of ['Bash', 'Read', 'Grep', 'mcp__plugin_enigma_enigma__enigma_request']) {
      expect(regex.test(tool)).toBe(true);
    }
  });
});
