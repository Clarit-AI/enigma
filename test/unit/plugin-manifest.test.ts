import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PLUGIN_ROOT = join(REPO_ROOT, 'plugins/enigma');

function readFrontmatter(path: string): { frontmatter: Record<string, string>; body: string } {
  const content = readFileSync(path, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`${path}: no YAML frontmatter block found`);
  const [, rawFrontmatter, body] = match;
  const frontmatter: Record<string, string> = {};
  for (const line of (rawFrontmatter ?? '').split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^"(.*)"$/, '$1');
    frontmatter[key] = value;
  }
  return { frontmatter, body: body ?? '' };
}

describe('plugins/enigma/skills/enigma/SKILL.md', () => {
  const path = join(PLUGIN_ROOT, 'skills/enigma/SKILL.md');

  it('exists', () => {
    expect(existsSync(path)).toBe(true);
  });

  it('has a name and a description with trigger phrases', () => {
    const { frontmatter } = readFrontmatter(path);
    expect(frontmatter.name).toBe('enigma');
    expect(frontmatter.description).toBeTruthy();
    expect((frontmatter.description ?? '').length).toBeGreaterThan(40);
  });

  it('instructs never to ask the user to paste a secret into the chat', () => {
    const { body } = readFrontmatter(path);
    expect(body).toMatch(/never ask the user to paste/i);
  });

  it('instructs calling enigma_request and using enigma run --', () => {
    const { body } = readFrontmatter(path);
    expect(body).toContain('enigma_request');
    expect(body).toMatch(/enigma run -- /);
  });

  it('treats a read-guard denial as an instruction, not an obstacle', () => {
    const { body } = readFrontmatter(path);
    expect(body).toMatch(/instruction, not an? obstacle/i);
  });

  it('explains prompt profiles against the usage hint before choosing a depository', () => {
    const { body } = readFrontmatter(path);
    expect(body).toMatch(/prompt profile/i);
    expect(body).toContain('unattended');
    expect(body).toMatch(/prompts-each-read/);
  });
});

describe('plugins/enigma/commands', () => {
  const COMMANDS = ['request', 'reveal', 'list', 'doctor', 'import', 'remove'];
  const DISABLE_MODEL_INVOCATION = new Set(['reveal', 'import', 'remove']);

  it.each(COMMANDS)('%s.md exists with a description', (name) => {
    const path = join(PLUGIN_ROOT, 'commands', `${name}.md`);
    expect(existsSync(path)).toBe(true);
    const { frontmatter } = readFrontmatter(path);
    expect(frontmatter.description).toBeTruthy();
  });

  it.each([...DISABLE_MODEL_INVOCATION])('%s.md sets disable-model-invocation: true', (name) => {
    const path = join(PLUGIN_ROOT, 'commands', `${name}.md`);
    const { frontmatter } = readFrontmatter(path);
    expect(frontmatter['disable-model-invocation']).toBe('true');
  });

  it.each(COMMANDS.filter((c) => !DISABLE_MODEL_INVOCATION.has(c)))('%s.md does not disable model invocation', (name) => {
    const path = join(PLUGIN_ROOT, 'commands', `${name}.md`);
    const { frontmatter } = readFrontmatter(path);
    expect(frontmatter['disable-model-invocation']).toBeUndefined();
  });

  describe('remove.md', () => {
    const { body } = readFrontmatter(join(PLUGIN_ROOT, 'commands', 'remove.md'));

    it('rejects an invalid or extra scope token instead of silently dropping it', () => {
      expect(body).toMatch(/exactly `project` or `global`/);
      expect(body).toMatch(/is invalid input\. Do not call the tool/);
    });

    it('requires an explicit affirmative reply before retrying with confirm: true', () => {
      expect(body).toContain('E_CONFIRMATION_REQUIRED');
      expect(body).toContain('confirm: true');
      expect(body).toMatch(/declines or doesn't answer, stop/);
    });

    it('does not promise scope as part of the relayed result', () => {
      expect(body).toMatch(/names, status, and depository/);
      expect(body).not.toMatch(/scope, and depository/);
    });
  });
});

describe('plugin manifests', () => {
  it('.claude-plugin/marketplace.json is valid JSON naming the clarit-enigma marketplace and enigma plugin', () => {
    const marketplace = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin/marketplace.json'), 'utf8')) as {
      name: string;
      plugins: Array<{ name: string; source: string }>;
    };
    expect(marketplace.name).toBe('clarit-enigma');
    expect(marketplace.plugins.some((p) => p.name === 'enigma' && p.source === './plugins/enigma')).toBe(true);
  });

  it('plugins/enigma/.claude-plugin/plugin.json is valid JSON naming the enigma plugin', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')) as { name: string };
    expect(plugin.name).toBe('enigma');
  });
});

describe('Issue #69 doc pins (AC11/AC12) — focused wording pins, not an eval harness', () => {
  it('AC11: SKILL.md documents the Monitor/status wake-on-submit pattern and the no-watcher fallback', () => {
    const { body } = readFrontmatter(join(PLUGIN_ROOT, 'skills/enigma/SKILL.md'));
    expect(body).toMatch(/background-watch/);
    expect(body).toContain('GET /r/<request_id>/status');
    expect(body).toMatch(/`\{"state":"pending"\}`/);
    expect(body).toMatch(/call `enigma_await` immediately/);
    // The watch must end on ANY non-pending response — fulfilled, 404, or a
    // connection failure — and hand off to enigma_await for the authoritative
    // outcome; a dead link is never polled forever (PR #78 review batch).
    expect(body).toMatch(/non-`pending`/);
    expect(body).toMatch(/connection failure/);
    expect(body).toMatch(/`enigma_await`[^\n]*authoritative outcome/);
  });

  it('AC12: docs/api-contracts.md documents GET /r/:id/status and E_OUTCOME_UNKNOWN', () => {
    const apiContracts = readFileSync(join(REPO_ROOT, 'docs/api-contracts.md'), 'utf8');
    expect(apiContracts).toContain('GET /r/:id/status');
    expect(apiContracts).toContain('E_OUTCOME_UNKNOWN');
    expect(apiContracts).toContain('E_REQUEST_EXPIRED');
  });
});
