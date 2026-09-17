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

    it(
      'KNOWN AND ACCEPTED gap: mv .env safe && cat safe is allowed end to end — mv is a lifecycle operation ' +
        "(correctly allowed on .env itself), but nothing here tracks a file's identity across two separate " +
        "commands, so the renamed copy's new name is just an ordinary path to the second command. Not chased: " +
        'nobody renames a .env and reads it back by accident, so this is deliberate evasion (see the top-of-file comment).',
      () => {
        expect(isDenied(bash('mv .env safe'))).toBe(false);
        expect(isDenied(bash('cat safe'))).toBe(false);
      },
    );

    it('cp and encode/decode commands are NOT part of that gap: they deny on the .env argument directly, before any second command runs', () => {
      expect(isDenied(bash('cp .env x'))).toBe(true);
      expect(isDenied(bash('base64 .env'))).toBe(true);
      expect(isDenied(bash('tar cf t.tar .env'))).toBe(true);
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

    it('denies command-substitution nesting past the depth bound rather than silently allowing it', () => {
      // 12 levels deep, past MAX_SUBSTITUTION_DEPTH (10) — nothing in here
      // literally mentions .env; this must still deny because the guard
      // could not fully unwrap it to check, not because it found anything.
      let command = 'true';
      for (let i = 0; i < 12; i++) command = `echo "$(${command})"`;
      expect(isDenied(bash(command))).toBe(true);
    });

    it('does not deny ordinary nesting comfortably inside the depth bound', () => {
      let command = 'true';
      for (let i = 0; i < 5; i++) command = `echo "$(${command})"`;
      expect(isDenied(bash(command))).toBe(false);
    });
  });

  describe('tokenizer-level shell evasions (fix batch review round 2)', () => {
    it.each<[string, string]>([
      ['cat${IFS}.env', '${IFS} word-splitting'],
      ['cat $IFS .env', 'bare $IFS word-splitting'],
      ["cat$IFS.env", '$IFS with no surrounding spaces at all'],
      ["op${IFS}read${IFS}op://Enigma/x/credential", '${IFS} defeating the op read rule'],
      ["security${IFS}find-generic-password${IFS}-w", '${IFS} defeating the keychain-read rule'],
      ["enigma${IFS}get${IFS}OPENAI_API_KEY", '${IFS} defeating the enigma get rule'],
      ["echo${IFS}$OPENAI_API_KEY", '${IFS} defeating the known-secret-echo rule'],
      [String.raw`cat $'\x2e\x65\x6e\x76'`, 'ANSI-C hex escapes spelling .env'],
      [String.raw`cat $'\056env'`, 'ANSI-C octal escape for the leading dot'],
    ])('%s -> denied (%s)', (command) => {
      expect(isDenied(bash(command))).toBe(true);
    });

    it('normalizing $IFS does not affect an ordinary command with no .env/secret reference', () => {
      expect(isDenied(bash('echo${IFS}hello'))).toBe(false);
    });

    it('normalizing $\'...\' does not affect an ordinary quoted string', () => {
      expect(isDenied(bash(String.raw`echo $'hello world'`))).toBe(false);
    });

    it(
      "KNOWN AND ACCEPTED false positive: echo '${IFS}.env' denies even though bash never expands ${IFS} inside " +
        'single quotes — normalizeShellEscapes has no quote tracking (round-3 review), and adding it would mean ' +
        're-implementing shell quoting, trading a guard that fails closed for a parser that can fail open. Do not ' +
        '"fix" this by adding quote awareness; see the comment on normalizeShellEscapes.',
      () => {
        expect(isDenied(bash("echo '${IFS}.env'"))).toBe(true);
      },
    );

    it('the false positive above is narrow: it only fires when the quoted text collapses to exactly a dotenv-looking token, not on ordinary surrounding text', () => {
      expect(isDenied(bash("echo 'write ${IFS}.env to docs'"))).toBe(false);
      expect(isDenied(bash(String.raw`grep -r '\$IFS' src/`))).toBe(false);
    });
  });

  describe('key=value argument tokens (Issue #46): dd if=, --file=, -o=, etc.', () => {
    it.each<[string, PreToolUseInput]>([
      ['dd if=.env bs=1 count=100', bash('dd if=.env bs=1 count=100')],
      ['dd if=.env', bash('dd if=.env')],
      ['dd if=.env.local', bash('dd if=.env.local')],
      ['awk -f=.env', bash('awk -f=.env')],
      ['python3 --file=.env', bash('python3 --file=.env')],
      ['somecmd --input=.env', bash('somecmd --input=.env')],
      ['somecmd -o=.env', bash('somecmd -o=.env')],
      ['dd if=./.env (slash no longer the only reason this denies)', bash('dd if=./.env')],
      ['dd if=/tmp/proj/.env', bash('dd if=/tmp/proj/.env')],
    ])('%s -> denied', (_label, input) => {
      expect(isDenied(input)).toBe(true);
    });

    it('still denies the already-working control cases from the issue report', () => {
      expect(isDenied(bash('cat .env'))).toBe(true);
      expect(isDenied(bash('base64 .env'))).toBe(true);
    });

    it('the value-side check also closes the equivalent gap for the Enigma config directory', () => {
      const enigmaHomeDir = process.env.ENIGMA_HOME as string;
      expect(isDenied(bash(`dd if=${join(enigmaHomeDir, 'index.json')}`))).toBe(true);
    });

    it(
      'KNOWN AND ACCEPTED false positive: a plain key=value argument that merely assigns a .env-looking ' +
        'string (not naming a file to read) also denies — make VAR=.env, FOO=.env some-command — because ' +
        'there is no way to tell "this key means read a file" (dd\'s if=) from "this key is just a variable ' +
        'name" (make\'s VAR=) from the token text alone, and this guard already denies the .env argument to ' +
        'every non-allowlisted command regardless of whether that invocation would actually read the bytes ' +
        '(cp, base64, tar, …). See tokenTargetsPath and the top-of-file comment.',
      () => {
        expect(isDenied(bash('make VAR=.env'))).toBe(true);
        expect(isDenied(bash('cp src=.env dst'))).toBe(true);
      },
    );

    it('does not deny an ordinary flag or key=value pair with no .env/config-path value', () => {
      expect(isDenied(bash('grep -n=5 pattern file.ts'))).toBe(false);
      expect(isDenied(bash('NODE_ENV=production npm start'))).toBe(false);
      expect(isDenied(bash('make VAR=value'))).toBe(false);
    });
  });

  describe('key=value argument tokens, round 2 (Issue #46): quoting and multiple "="', () => {
    it.each<[string, PreToolUseInput]>([
      ["dd if='.env' (single-quoted value)", bash("dd if='.env'")],
      ['dd if=".env" (double-quoted value)', bash('dd if=".env"')],
      ["dd 'if=.env' (whole token quoted — already worked, must keep working)", bash("dd 'if=.env'")],
      ['a=b=.env (dotenv hidden behind a second =)', bash('dd a=b=.env')],
      ["a=b='.env' (second = AND a quoted value, combined)", bash("dd a=b='.env'")],
      [String.raw`dd if=$'\x2e\x65\x6e\x76' (ANSI-C-quoted value reaches the value-side check too)`, bash(String.raw`dd if=$'\x2e\x65\x6e\x76'`)],
    ])('%s -> denied', (_label, input) => {
      expect(isDenied(input)).toBe(true);
    });

    it('the multi-= check does not stop at a suffix that only coincidentally contains another key=value pair', () => {
      expect(isDenied(bash('dd a=b=c'))).toBe(false);
    });

    it(
      'KNOWN AND ACCEPTED gap: a bare backslash escape outside $\'...\' (if=\\.env) is not un-escaped and so ' +
        'is not recognized — same boundary as the rest of this file (PR #32 ruling): nothing here un-escapes a ' +
        'bare backslash generally (only $\'...\' bodies are decoded), and doing so would mean re-implementing ' +
        'shell escaping. Not new to this fix, and not chased for the same reason normalizeShellEscapes declines ' +
        'to track quote context.',
      () => {
        expect(isDenied(bash(String.raw`dd if=\.env`))).toBe(false);
      },
    );

    it(
      'decided outcome: a quoted value with interior whitespace that still reduces to a dotenv basename ' +
        "denies (targetsDotEnv trims before matching, same as every other path check in this file) — the safe " +
        'direction for an ambiguous case, consistent with the rest of the guard.',
      () => {
        expect(isDenied(bash("dd if=' .env'"))).toBe(true);
      },
    );
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

    describe('a Grep call that already set a glob filter is judged by whether that glob could reach .env (fix batch review)', () => {
      it.each<[string, string]>([
        ['*.ts', 'a TypeScript-only filter'],
        ['**/*.json', 'a JSON-only filter, nested'],
        ['src/**/*.tsx', 'a restricted, path-prefixed filter'],
        ['*.{js,ts}', 'a brace-expanded, still non-.env filter'],
        ['*.[jt]s', 'a bracket character class that cannot spell .env (review fix batch 2)'],
      ])('passes through unchanged: glob "%s" (%s) cannot match a .env file', (glob) => {
        const input = grep('.', tmpProject, { glob });
        const result = runReadGuard(input);
        expect(result).toBeUndefined();
      });

      it.each<[string, string]>([
        // .env and .env.{local,production} are denied even earlier, by the
        // generic per-field dotenv check that runs before this glob logic
        // (their literal string already looks like a dotenv path) — still a
        // deny, just via a different, still-accurate reason. Asserted below,
        // separately, only for gloBs that specifically exercise the new logic.
        ['.env', 'names .env exactly'],
        ['.env*', 'matches every .env-family file'],
        ['*', 'unrestricted — matches anything'],
        ['**', 'unrestricted — matches anything, any depth'],
        ['**/*', 'unrestricted — matches anything, any depth (explicit form)'],
        ['.env.{local,production}', 'brace-expanded, but every alternative is a real .env file'],
      ])('falls back to deny: glob "%s" (%s) could reach a .env file', (glob) => {
        const input = grep('.', tmpProject, { glob });
        expect(isDenied(input)).toBe(true);
      });

      it.each(['.env*', '*', '**', '**/*'])(
        'glob "%s" is denied specifically via the --glob fallback reason (reaches globCouldMatchDotEnv)',
        (glob) => {
          const reason = denialReason(grep('.', tmpProject, { glob }));
          expect(reason).toContain('--glob');
        },
      );

      it('a bracket character class that CAN spell .env is still denied (review fix batch 2: real matching, not always-deny)', () => {
        const input = grep('.', tmpProject, { glob: '[.]env*' });
        expect(isDenied(input)).toBe(true);
      });
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
