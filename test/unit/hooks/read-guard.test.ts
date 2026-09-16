import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runReadGuard } from '../../../src/hooks/read-guard.js';
import { indexPath } from '../../../src/core/paths.js';
import type { IndexEntry, IndexFile } from '../../../src/core/index-store.js';
import type { PreToolUseInput } from '../../../src/hooks/types.js';

function seedIndex(names: string[]): void {
  const entries: IndexEntry[] = names.map((name) => ({
    name,
    scope: 'global',
    depository: 'encrypted',
    ref: `global/${name}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  const index: IndexFile = { version: 1, entries };
  writeFileSync(indexPath(), JSON.stringify(index));
}

function bash(command: string, cwd = '/tmp'): PreToolUseInput {
  return { tool_name: 'Bash', tool_input: { command }, cwd };
}

function read(file_path: string, cwd = '/tmp'): PreToolUseInput {
  return { tool_name: 'Read', tool_input: { file_path }, cwd };
}

function grep(path: string, cwd = '/tmp'): PreToolUseInput {
  return { tool_name: 'Grep', tool_input: { pattern: 'x', path }, cwd };
}

function glob(pattern: string, cwd = '/tmp'): PreToolUseInput {
  return { tool_name: 'Glob', tool_input: { pattern }, cwd };
}

function isDenied(input: PreToolUseInput): boolean {
  return runReadGuard(input) !== undefined;
}

function denialReason(input: PreToolUseInput): string | undefined {
  const result = runReadGuard(input);
  return result?.hookSpecificOutput.permissionDecisionReason;
}

describe('PreToolUse read-guard', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
    seedIndex(['OPENAI_API_KEY']);
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('denies (table-driven, AC2/AC3)', () => {
    it.each<[string, PreToolUseInput]>([
      ['Read .env', read('/repo/.env')],
      ['Read .env.local', read('/repo/.env.local')],
      ['Grep path .env', grep('/repo/.env')],
      ['Glob pattern .env', glob('.env')],
      ['Bash cat .env', bash('cat .env')],
      ['Bash grep KEY .env', bash('grep KEY .env')],
      ['Bash sed on .env', bash("sed -n '1p' .env")],
      ['Bash head .env', bash('head .env')],
      ['Bash tail -f .env', bash('tail -f .env')],
      ['Bash awk on .env', bash("awk '{print}' .env")],
      ['Bash printenv', bash('printenv')],
      ['Bash env', bash('env')],
      ['Bash enigma get X', bash('enigma get OPENAI_API_KEY')],
      ['Bash enigma env', bash('enigma env')],
      ['Bash security find-generic-password', bash('security find-generic-password -s enigma -a x -w')],
      ['Bash op read', bash('op read op://Enigma/x/credential')],
      ['Bash echo $OPENAI_API_KEY (known name)', bash('echo $OPENAI_API_KEY')],
      ['Bash echo ${OPENAI_API_KEY} (braced, known name)', bash('echo ${OPENAI_API_KEY}')],
      ['Bash chained: harmless && cat .env', bash('echo hi && cat .env')],
    ])('%s', (_label, input) => {
      expect(isDenied(input)).toBe(true);
    });

    // Built inside the test body (not the it.each table above), since these paths
    // depend on tmpHome, which beforeEach only sets after the table is built.
    it('denies reading Enigma\'s config directory directly', () => {
      expect(isDenied(read(join(tmpHome, 'index.json')))).toBe(true);
    });

    it('denies a Bash command reading a file under Enigma\'s config directory', () => {
      expect(isDenied(bash(`cat ${join(tmpHome, 'audit.log')}`))).toBe(true);
    });

    it('denial reason for a .env read mentions enigma_request and enigma run', () => {
      const reason = denialReason(read('/repo/.env'));
      expect(reason).toContain('enigma_request');
      expect(reason).toContain('enigma run --');
    });

    it('denial reason for enigma get mentions the alternative', () => {
      const reason = denialReason(bash('enigma get OPENAI_API_KEY'));
      expect(reason).toContain('enigma_request');
    });
  });

  describe('allows (table-driven, AC2/AC3)', () => {
    it.each<[string, PreToolUseInput]>([
      ['Read .env.example', read('/repo/.env.example')],
      ['Grep path .env.example', grep('/repo/.env.example')],
      ['Bash cat .env.example', bash('cat .env.example')],
      ['enigma run -- npm start', bash('enigma run -- npm start')],
      ['enigma list', bash('enigma list')],
      ['echo hello (ordinary command)', bash('echo hello')],
      ['echo $UNKNOWN_NAME (not in the index)', bash('echo $UNKNOWN_NAME')],
      ['Read an ordinary source file', read('/repo/src/index.ts')],
      ['Grep an ordinary path', grep('/repo/src')],
      ['Glob an ordinary pattern', glob('**/*.ts')],
      ['Bash ordinary git status', bash('git status')],
      ['Bash cat an ordinary file', bash('cat README.md')],
    ])('%s', (_label, input) => {
      expect(isDenied(input)).toBe(false);
    });
  });

  it('returns undefined for a tool the guard does not cover (e.g. Write)', () => {
    const input = { tool_name: 'Write', tool_input: { file_path: '/repo/.env' }, cwd: '/tmp' } as PreToolUseInput;
    expect(runReadGuard(input)).toBeUndefined();
  });

  it('treats a missing cwd by falling back to process.cwd() without throwing', () => {
    expect(() => runReadGuard({ tool_name: 'Bash', tool_input: { command: 'echo hi' } })).not.toThrow();
  });

  it('treats an empty tool_input without throwing', () => {
    expect(() => runReadGuard({ tool_name: 'Bash', tool_input: {}, cwd: '/tmp' })).not.toThrow();
  });
});
