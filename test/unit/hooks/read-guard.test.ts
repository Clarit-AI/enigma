import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function grep(path: string, cwd = '/tmp', extra: Record<string, unknown> = {}): PreToolUseInput {
  return { tool_name: 'Grep', tool_input: { pattern: 'SECRET', path, output_mode: 'content', ...extra }, cwd };
}

function glob(pattern: string, cwd = '/tmp'): PreToolUseInput {
  return { tool_name: 'Glob', tool_input: { pattern }, cwd };
}

function isDenied(input: PreToolUseInput): boolean {
  const result = runReadGuard(input);
  return result?.hookSpecificOutput.permissionDecision === 'deny';
}

function denialReason(input: PreToolUseInput): string | undefined {
  const result = runReadGuard(input);
  if (result?.hookSpecificOutput.permissionDecision !== 'deny') return undefined;
  return result.hookSpecificOutput.permissionDecisionReason;
}

function updatedInputFor(input: PreToolUseInput): Record<string, unknown> | undefined {
  const result = runReadGuard(input);
  if (result?.hookSpecificOutput.permissionDecision !== 'allow') return undefined;
  return result.hookSpecificOutput.updatedInput;
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

  describe('target-based Bash dotenv denial (fix batch #2): any command, not just an enumerated utility', () => {
    it.each<[string, PreToolUseInput]>([
      ['less .env', bash('less .env')],
      ['xxd .env', bash('xxd .env')],
      ['strings .env', bash('strings .env')],
      ['more .env', bash('more .env')],
      ['vim .env (opens for editing, which still reads it)', bash('vim .env')],
      ['base64 .env', bash('base64 .env')],
      ['wc .env', bash('wc -l .env')],
      ['diff .env .env.example', bash('diff .env .env.example')],
      ['source .env (fix batch #3)', bash('source .env')],
      ['. .env (dot-sourcing, fix batch #3)', bash('. .env')],
      ['cp .env /tmp/copy (copying a source .env)', bash('cp .env /tmp/copy')],
    ])('%s -> denied', (_label, input) => {
      expect(isDenied(input)).toBe(true);
    });
  });

  describe('non-reading verbs on .env are allowed (fix batch #2)', () => {
    it.each<[string, PreToolUseInput]>([
      ['rm .env', bash('rm .env')],
      ['mv .env .env.bak', bash('mv .env .env.bak')],
      ['touch .env', bash('touch .env')],
      ['chmod 600 .env', bash('chmod 600 .env')],
      ['stat .env', bash('stat .env')],
      ['ls -la .env', bash('ls -la .env')],
      ['find . -name .env', bash('find . -name .env')],
      ['test -f .env', bash('test -f .env')],
    ])('%s -> allowed', (_label, input) => {
      expect(isDenied(input)).toBe(false);
    });
  });

  describe('command substitution is unwrapped (fix batch #2/#3)', () => {
    it('denies eval "$(cat .env)" via its unwrapped inner command', () => {
      expect(isDenied(bash('eval "$(cat .env)"'))).toBe(true);
    });

    it('denies a backtick-substitution equivalent', () => {
      expect(isDenied(bash('eval `cat .env`'))).toBe(true);
    });

    it('denies a nested substitution one level deep', () => {
      expect(isDenied(bash('echo "$(echo "$(cat .env)")"'))).toBe(true);
    });

    it('does not deny a substitution with no secret-relevant content', () => {
      expect(isDenied(bash('echo "$(date)"'))).toBe(false);
    });
  });

  describe('Grep directory-rooted searches get a .env exclusion instead of an outright deny (fix batch #1)', () => {
    let tmpProject: string;

    beforeEach(() => {
      tmpProject = mkdtempSync(join(tmpdir(), 'enigma-project-'));
      writeFileSync(join(tmpProject, '.env'), 'OPENAI_API_KEY=sk-sentinel\n');
      writeFileSync(join(tmpProject, 'README.md'), '# hello\n');
      mkdirSync(join(tmpProject, 'src'));
    });

    afterEach(() => {
      rmSync(tmpProject, { recursive: true, force: true });
    });

    it('reproduces the reported gap as a baseline: a directory-rooted content Grep is not denied outright', () => {
      const input = grep('.', tmpProject);
      expect(isDenied(input)).toBe(false);
    });

    it('adds a .env* glob exclusion when path is a directory and no glob was set', () => {
      const input = grep('.', tmpProject);
      const updated = updatedInputFor(input);
      expect(updated).toBeDefined();
      expect(updated?.glob).toBe('!.env*');
      expect(updated?.pattern).toBe('SECRET');
    });

    it('adds the exclusion when path is omitted entirely (search rooted at cwd)', () => {
      const input: PreToolUseInput = { tool_name: 'Grep', tool_input: { pattern: 'SECRET', output_mode: 'content' }, cwd: tmpProject };
      const updated = updatedInputFor(input);
      expect(updated?.glob).toBe('!.env*');
    });

    it('adds the exclusion when path does not exist yet (fails safe toward adding it)', () => {
      const input = grep(join(tmpProject, 'does-not-exist-yet'), tmpProject);
      const updated = updatedInputFor(input);
      expect(updated?.glob).toBe('!.env*');
    });

    it('falls back to deny when the caller already set a glob filter (cannot combine in one field)', () => {
      const input = grep('.', tmpProject, { glob: '*.ts' });
      expect(isDenied(input)).toBe(true);
      expect(denialReason(input)).toContain('--glob');
    });

    it('does not rewrite a Grep targeting one specific existing non-directory file', () => {
      const input = grep(join(tmpProject, 'README.md'), tmpProject);
      const result = runReadGuard(input);
      expect(result).toBeUndefined();
    });

    it('does not rewrite (and does not deny) a Grep targeting .env.example as a specific existing file', () => {
      writeFileSync(join(tmpProject, '.env.example'), 'OPENAI_API_KEY=\n');
      const input = grep(join(tmpProject, '.env.example'), tmpProject);
      expect(runReadGuard(input)).toBeUndefined();
    });

    it('still denies a Grep that names .env directly, before the exclusion logic ever runs', () => {
      const input = grep(join(tmpProject, '.env'), tmpProject);
      expect(isDenied(input)).toBe(true);
    });
  });

  describe('allows (table-driven, AC2/AC3)', () => {
    it.each<[string, PreToolUseInput]>([
      ['Read .env.example', read('/repo/.env.example')],
      ['Bash cat .env.example', bash('cat .env.example')],
      ['enigma run -- npm start', bash('enigma run -- npm start')],
      ['enigma list', bash('enigma list')],
      ['echo hello (ordinary command)', bash('echo hello')],
      ['echo $UNKNOWN_NAME (not in the index)', bash('echo $UNKNOWN_NAME')],
      ['Read an ordinary source file', read('/repo/src/index.ts')],
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
