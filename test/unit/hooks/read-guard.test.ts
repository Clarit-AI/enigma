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

    it('never names a CLI path that does not exist', () => {
      // The remediation text is the one instruction an agent actually gets
      // after a denial, so it must be runnable. Under test the plugin root
      // infers to `src/`, which has no `dist/cli.mjs` — the denial must fall
      // back to the plain form rather than pointing at a phantom bundle
      // (ADR-006).
      const reason = denialReason(read('/repo/.env'));

      expect(reason).not.toMatch(/node "[^"]*\/src\/dist\/cli\.mjs"/);
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

  describe('quote-splicing, round 3 (Issue #46): tokenize itself resolves quotes throughout a token, not just at its edges', () => {
    it.each<[string, PreToolUseInput]>([
      ["dd if=''.env (empty single-quoted span spliced before .env)", bash("dd if=''.env")],
      ['dd if=.e""nv (empty double-quoted span spliced mid-word)', bash('dd if=.e""nv')],
      ["dd if=\"\".env (empty double-quoted span spliced before .env)", bash('dd if="".env')],
      ["cat ''.env (bare path, no key=value involved at all)", bash("cat ''.env")],
      ["cat .en''v (bare path, spliced mid-word)", bash("cat .en''v")],
      ['cat .e""nv (bare path, double-quoted splice)', bash('cat .e""nv')],
    ])('%s -> denied', (_label, input) => {
      expect(isDenied(input)).toBe(true);
    });

    it(
      "a filename that genuinely contains a quote character is still recognized correctly when it's expressed " +
        'the way bash itself requires — by switching quote types, not by an unquoted literal quote mark. This is ' +
        "not a new cost: tokenize now pairs quote spans properly rather than blindly deleting every quote " +
        'character, so this case is actually more correct than before, not less.',
      () => {
        // 'it'"'"'s.env' is the standard bash idiom for embedding a literal apostrophe in an otherwise
        // single-quoted string: 'it' + "'" + 's.env' concatenated with no gaps -> the literal filename
        // it's.env, confirmed against real bash (not just this guard's own parsing) before pinning it here.
        const embedsLiteralQuote = ["cat ", "'", 'it', "'", '"', "'", '"', "'", 's.env', "'"].join('');
        expect(embedsLiteralQuote).toBe(`cat 'it'"'"'s.env'`);
        expect(isDenied(bash(embedsLiteralQuote))).toBe(false);
        expect(isDenied(bash(`${embedsLiteralQuote} README.md`))).toBe(false);
      },
    );

    it(
      'KNOWN AND ACCEPTED decision: an unmatched quote mark (no closing quote anywhere later in the token) is ' +
        'treated as an ordinary literal character, not as an unterminated span that swallows the rest of the ' +
        'segment — the "mis-parse toward allow" direction used everywhere else in this file. A malformed/unmatched ' +
        'quote is not valid shell syntax to begin with (real bash would treat it as an incomplete command), so this ' +
        "is judged narrow. The upside: a genuine .env reference elsewhere in the same segment isn't swallowed into " +
        'one unmatched blob and missed.',
      () => {
        expect(isDenied(bash("cat unmatched'.env"))).toBe(false);
        expect(isDenied(bash("cat unmatched' README.md .env"))).toBe(true);
      },
    );

    it(
      'behavior change from round 2, deliberate and correct: a non-reading verb spelled with a quote-splice ' +
        '(r\'\'m, the same trick used to bypass the deny rules) is now correctly recognized as "rm" by the ' +
        'NON_READING_BASH_VERBS allowlist too, so r\'\'m .env is allowed — same as rm .env, because it IS rm .env ' +
        'once quoting is resolved. This is a correctness fix to the allow path, not a new gap: real bash resolves ' +
        'the quoting identically before rm ever sees its argv.',
      () => {
        expect(isDenied(bash("r''m .env"))).toBe(false);
      },
    );

    it('the same tokenize fix closes quote-splicing on a command NAME for every other Bash rule, not just the .env-path ones', () => {
      expect(isDenied(bash("pr''intenv"))).toBe(true);
      expect(isDenied(bash("en''igma get OPENAI_API_KEY"))).toBe(true);
      expect(isDenied(bash("sec''urity find-generic-password -s enigma -a x -w"))).toBe(true);
      expect(isDenied(bash("o''p read op://Enigma/x/credential"))).toBe(true);
      expect(isDenied(bash("ec''ho $OPENAI_API_KEY"))).toBe(true);
    });

    it('quote-splicing that spells an ordinary, non-dotenv value is still allowed — this is not a blanket new denial', () => {
      expect(isDenied(bash("echo ''hello"))).toBe(false);
      expect(isDenied(bash('git status'))).toBe(false);
      expect(isDenied(bash("cat '' README.md"))).toBe(false);
    });
  });

  describe('splitSegments is quote-aware (Issue #48): a separator character inside a quoted span is a literal, not a command boundary', () => {
    it(
      'CONFIRMED LIVE BYPASS before this fix, verified against the built hook binary: a standalone quoted ' +
        'separator token right after a command name sliced one real bash command into two fragments — one with ' +
        "the command name and no target, one with the target and no command name — so segmentEchoesKnownSecret's " +
        "head==='echo' check never saw the fragment containing the secret name. `echo ';' $NAME` is, in real bash, " +
        'a single `echo` invocation that prints both the literal `;` and the secret value; probing it against ' +
        'plugins/enigma/dist/hooks.mjs with a seeded OPENAI_API_KEY returned no denial at all prior to this fix. ' +
        'All three separator characters this guard recognizes are pinned here, not just `;`.',
      () => {
        expect(isDenied(bash("echo ';' $OPENAI_API_KEY"))).toBe(true);
        expect(isDenied(bash("echo '&' $OPENAI_API_KEY"))).toBe(true);
        expect(isDenied(bash("echo '|' $OPENAI_API_KEY"))).toBe(true);
        expect(isDenied(bash('echo "&" $OPENAI_API_KEY'))).toBe(true);
      },
    );

    it(
      'NOT independently vulnerable — pinned as a regression guard, not a second bypass: verified against the ' +
        'pre-fix binary that both of these were ALREADY correctly denied before this change, for a structural ' +
        "reason, not luck. segmentTargetsDotEnvByPath checks every token in a segment's rest array regardless of " +
        "position, so even when the old blind split displaced .env into its own fragment, the leftover stray " +
        "quote character from the split always became that fragment's head, pushing .env into rest where it was " +
        "still checked. segmentIsBareEnvDump only ever needs a single head token match with no separate target " +
        'reference elsewhere in the command, so there was nothing for over-splitting to displace away from it. ' +
        'This asymmetry — some rules structurally immune, others not — is why the fix could not be "just re-run ' +
        'the same probe on every rule and see which still fail": the two rules below stayed correct throughout.',
      () => {
        expect(isDenied(bash("cat ';' .env"))).toBe(true);
        expect(isDenied(bash("printenv ';' -0"))).toBe(true);
    });

    it(
      'NOT a live bypass, deliberately not "fixed" further: the same quoted-separator shape placed between a ' +
        "command name and its exact-position subcommand (segmentIsEnigmaGetOrEnv/segmentIsKeychainRead/" +
        "segmentIsOpRead all destructure tokenize(segment) as [head, sub]) makes the guard's parse of the " +
        "real argv accurately show sub !== 'get'/'find-generic-password'/'read' — because in real bash, " +
        "`enigma ';' get NAME` genuinely puts the literal `;` at that argv position, not `get`. The guard is " +
        "now agreeing with reality, not missing anything: the real `enigma`/`security`/`op` binaries would see " +
        'that same corrupted argv and reject it as an unrecognized subcommand before ever reading anything. ' +
        'This is different in kind from the echo case above, where the real command DOES still function ' +
        '(echo tolerates and prints extra arguments) — these do not.',
      () => {
        expect(isDenied(bash("enigma ';' get OPENAI_API_KEY"))).toBe(false);
        expect(isDenied(bash("security ';' find-generic-password -s x -w"))).toBe(false);
        expect(isDenied(bash("op ';' read op://vault/item/field"))).toBe(false);
      },
    );

    it('a quoted separator anywhere else in an already-recognized command does not change the outcome', () => {
      expect(isDenied(bash("enigma get OPENAI_API_KEY ';'"))).toBe(true);
      expect(isDenied(bash("security find-generic-password -s x -w ';'"))).toBe(true);
      expect(isDenied(bash("op read ';' op://vault/item/field"))).toBe(true);
    });

    it('a quoted separator character is still a literal when it sits inside a longer quoted word, not only when quoted alone', () => {
      expect(isDenied(bash("echo 'a;b' $OPENAI_API_KEY"))).toBe(true);
      expect(isDenied(bash('cat "foo;.env"'))).toBe(false); // real filename is "foo;.env", not .env — correctly not a dotenv match
    });

    it('real command chains (unquoted separators) still split and get checked independently — this is not a regression to "never split"', () => {
      expect(isDenied(bash('cat .env && echo hi'))).toBe(true);
      expect(isDenied(bash('echo hi && cat .env'))).toBe(true);
      expect(isDenied(bash('true; cat .env'))).toBe(true);
      expect(isDenied(bash('cat .env | grep KEY'))).toBe(true);
      expect(isDenied(bash('echo hi; echo $OPENAI_API_KEY'))).toBe(true);
    });

    it('quote-aware splitting composes correctly with command-substitution unwrapping', () => {
      expect(isDenied(bash('eval "$(cat .env)"'))).toBe(true);
      expect(isDenied(bash("eval \"$(echo ';' $OPENAI_API_KEY)\""))).toBe(true);
    });

    it(
      'KNOWN AND ACCEPTED decision, same "mis-parse toward allow" direction as tokenize: an unmatched quote mark ' +
        'does not turn the rest of the command into a protected span. A separator after an unterminated quote ' +
        'still splits normally.',
      () => {
        expect(isDenied(bash("echo unmatched' ; cat .env"))).toBe(true);
      },
    );

    describe('false-positive sweep, re-run against this change specifically (the previous sweep was against a different change and does not carry over)', () => {
      it.each<[string, PreToolUseInput]>([
        ['git status', bash('git status')],
        ['npm test', bash('npm test')],
        ['make BUILD=release', bash('make BUILD=release')],
        ["curl -H 'Authorization: Bearer x=y' url", bash("curl -H 'Authorization: Bearer x=y' url")],
        ['sql -e "select \'a=b.env\'"', bash('sql -e "select \'a=b.env\'"')],
        ['docker run -e NODE_ENV=prod img', bash('docker run -e NODE_ENV=prod img')],
        ['cat .env.example', bash('cat .env.example')],
        ['enigma run -- npm start', bash('enigma run -- npm start')],
        ["echo 'hello world'", bash("echo 'hello world'")],
        ["echo 'a;b' (quoted separator, ordinary content)", bash("echo 'a;b'")],
        ["grep 'foo|bar' file (quoted separator, ordinary content)", bash("grep 'foo|bar' file")],
        ['awk \'{print $1 && $2}\' f (quoted separator, ordinary content)', bash("awk '{print $1 && $2}' f")],
      ])('%s -> allowed', (_label, input) => {
        expect(isDenied(input)).toBe(false);
      });
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

  describe('the child of `enigma run --` is checked like a top-level segment (Issue #92)', () => {
    it.each<[string, string]>([
      ['printenv of a secret', 'enigma run -- printenv OPENAI_API_KEY'],
      ['bare env', 'enigma run -- env'],
      ['flags before --', 'enigma run --only FOO -- printenv FOO'],
      ['--scope flag before --', 'enigma run --scope global --only FOO,BAR -- env'],
      ['enigma get as the child', 'enigma run -- enigma get FOO'],
      ['enigma env as the child', 'enigma run -- enigma env'],
      ['cat .env as the child', 'enigma run -- cat .env'],
      ['env by absolute path', 'enigma run -- /usr/bin/env'],
      ['quoted child command name', "enigma run -- 'printenv' OPENAI_API_KEY"],
      ['enigma by absolute path', '/usr/local/bin/enigma run -- printenv OPENAI_API_KEY'],
      ['nested enigma run', 'enigma run -- enigma run -- printenv OPENAI_API_KEY'],
      ['later in a chain', 'cd /repo && enigma run -- printenv OPENAI_API_KEY'],
      ['piped onward', 'enigma run -- printenv OPENAI_API_KEY | head -1'],
      ['inside a command substitution', 'echo "$(enigma run -- printenv OPENAI_API_KEY)"'],
      ['bundled-CLI form runHint() recommends', 'node "/plugin/dist/cli.mjs" run -- printenv OPENAI_API_KEY'],
      ['bundled-CLI form with node flags', 'node --no-warnings /plugin/dist/cli.mjs run --only FOO -- env'],
      ['keychain read as the child', 'enigma run -- security find-generic-password -s x -w'],
    ])('denies: %s', (_label, command) => {
      expect(isDenied(bash(command))).toBe(true);
    });

    it.each<[string, string]>([
      ['npm run dev', 'enigma run -- npm run dev'],
      ['node server.js', 'enigma run -- node server.js'],
      ['docker compose up', 'enigma run -- docker compose up'],
      ['flags before --, ordinary child', 'enigma run --only FOO -- node server.js'],
      ['--scope flag, ordinary child', 'enigma run --scope project -- npm test'],
      ['.env.example as an argument', 'enigma run -- cat .env.example'],
      ['no child (nothing after run)', 'enigma run'],
      ['flags but no --', 'enigma run --only FOO'],
      ['-- with an empty child', 'enigma run --only FOO --'],
      ['another subcommand mentioning run', 'enigma list -- printenv'],
      ['node script that is not the enigma CLI', 'node server.js run -- npm start'],
      ['`--` only counts after run: env is an argument, not the child', 'enigma run --only env -- npm start'],
    ])('allows: %s', (_label, command) => {
      expect(isDenied(bash(command))).toBe(false);
    });

    it('denial text for an env dump under `enigma run` names a runnable alternative, not the denied form alone', () => {
      const reason = denialReason(bash('enigma run -- printenv OPENAI_API_KEY'));
      expect(reason).toContain('enigma list');
      expect(reason).toContain('enigma run -- <command>');
      expect(reason).toContain('still print secret values');
    });

    it('the top-level env-dump denial text is unchanged', () => {
      const reason = denialReason(bash('printenv OPENAI_API_KEY'));
      expect(reason).toContain('can dump secret values into this session');
    });

    it('a child that goes through an existing rule reports that rule, not a special case', () => {
      expect(denialReason(bash('enigma run -- enigma get FOO'))).toContain('print a secret value to stdout');
      expect(denialReason(bash('enigma run -- cat .env'))).toContain('Reading .env files directly is blocked');
    });

    // Known, accepted gap — pinned, not silently missed, same as the other
    // "not chased" boundaries in this file. `sh -c '…'` is not unwrapped for a
    // bare segment either (`sh -c 'printenv X'` is allowed today), so `enigma
    // run` does not change that. Tracked as out of scope in Issue #92.
    it('does not unwrap `sh -c` inside the child (same as a bare segment)', () => {
      expect(isDenied(bash("sh -c 'printenv OPENAI_API_KEY'"))).toBe(false);
      expect(isDenied(bash("enigma run -- sh -c 'printenv OPENAI_API_KEY'"))).toBe(false);
    });
  });

  describe('bundled-CLI form: node flags with a separate value, and non-Enigma scripts (Issue #96)', () => {
    let root: string;
    let enigmaCli: string;
    let foreignCli: string;
    let nameless: string;
    let broken: string;

    function plant(name: string, manifest: string | null): string {
      const dist = join(root, name, 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'cli.mjs'), '');
      if (manifest !== null) {
        mkdirSync(join(root, name, '.claude-plugin'), { recursive: true });
        writeFileSync(join(root, name, '.claude-plugin', 'plugin.json'), manifest);
      }
      return join(dist, 'cli.mjs');
    }

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'enigma-bundles-'));
      enigmaCli = plant('enigma', JSON.stringify({ name: 'enigma', version: '0.3.1' }));
      foreignCli = plant('foreign', JSON.stringify({ name: 'other-tool', version: '1.0.0' }));
      nameless = plant('nameless', JSON.stringify({ version: '1.0.0' }));
      broken = plant('broken', '{ not json');
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it.each<[string]>([
      ['--require'],
      ['-r'],
      ['--import'],
      ['--loader'],
      ['--experimental-loader'],
      ['--conditions'],
      ['-C'],
    ])('denies an Enigma bundle behind `node %s <value>`', (flag) => {
      expect(isDenied(bash(`node ${flag} ./preload.mjs ${enigmaCli} run -- printenv OPENAI_API_KEY`))).toBe(true);
    });

    it('denies with several value-taking flags and a plain flag mixed together', () => {
      const command = `node --no-warnings --require ./a.mjs --import ./b.mjs ${enigmaCli} run --only FOO -- env`;
      expect(isDenied(bash(command))).toBe(true);
    });

    it('denies the `--flag=value` form, which is a single token', () => {
      expect(isDenied(bash(`node --require=./preload.mjs ${enigmaCli} run -- printenv OPENAI_API_KEY`))).toBe(true);
    });

    it('a flag value is not mistaken for the script: `node --require x` with no script allows', () => {
      expect(isDenied(bash('node --require ./preload.mjs server.js'))).toBe(false);
      expect(isDenied(bash('node --require ./preload.mjs'))).toBe(false);
    });

    it('resolves a relative script against the hook cwd', () => {
      const command = 'node dist/cli.mjs run -- printenv OPENAI_API_KEY';
      expect(isDenied(bash(command, join(root, 'enigma')))).toBe(true);
      expect(isDenied(bash(command, join(root, 'foreign')))).toBe(false);
    });

    describe('a cli.mjs that is not an Enigma bundle', () => {
      it('is allowed when its plugin manifest is readable and names another plugin', () => {
        expect(isDenied(bash(`node ${foreignCli} run -- printenv OPENAI_API_KEY`))).toBe(false);
      });

      it('is allowed when its readable manifest has no name', () => {
        expect(isDenied(bash(`node ${nameless} run -- printenv OPENAI_API_KEY`))).toBe(false);
      });

      it('is still denied when the same child is run bare after it', () => {
        expect(isDenied(bash(`node ${foreignCli} run -- npm start && printenv OPENAI_API_KEY`))).toBe(true);
      });
    });

    describe('a script that cannot be resolved keeps denying (conservative default)', () => {
      it.each<[string, () => string]>([
        ['not laid out as <root>/dist/cli.mjs', () => '/some/other/project/cli.mjs'],
        ['missing file and manifest', () => join(root, 'gone', 'dist', 'cli.mjs')],
        ['bundle with no manifest', () => plant('bare', null)],
        ['unparseable manifest', () => broken],
        ['unexpanded variable', () => '"$CLAUDE_PLUGIN_ROOT/dist/cli.mjs"'],
      ])('%s', (_label, script) => {
        expect(isDenied(bash(`node ${script()} run -- printenv OPENAI_API_KEY`))).toBe(true);
      });
    });
  });

  describe('leading NAME=value / time / command prefixes (Issue #96)', () => {
    it.each<[string, string]>([
      ['assignment before printenv', 'FOO=1 printenv OPENAI_API_KEY'],
      ['assignment before env', 'FOO=1 env'],
      ['two assignments', 'FOO=1 BAR=2 printenv OPENAI_API_KEY'],
      ['quoted assignment value', 'FOO="a b" printenv OPENAI_API_KEY'],
      ['time before printenv', 'time printenv OPENAI_API_KEY'],
      ['command before printenv', 'command printenv OPENAI_API_KEY'],
      ['mixed prefixes', 'FOO=1 time command printenv OPENAI_API_KEY'],
      ['prefix later in a chain', 'cd /repo && FOO=1 printenv OPENAI_API_KEY'],
      ['prefix inside a command substitution', 'echo "$(FOO=1 printenv OPENAI_API_KEY)"'],
      ['assignment before enigma get', 'FOO=1 enigma get OPENAI_API_KEY'],
      ['time before keychain read', 'time security find-generic-password -s x -w'],
      ['assignment before op read', 'FOO=1 op read op://vault/item/field'],
      ['assignment before echoing a known secret', 'FOO=1 echo $OPENAI_API_KEY'],
      ['assignment before enigma run', 'FOO=1 enigma run -- printenv OPENAI_API_KEY'],
      ['time before enigma run', 'time enigma run -- printenv OPENAI_API_KEY'],
      ['prefix on the enigma run child', 'enigma run -- FOO=1 printenv OPENAI_API_KEY'],
      ['prefixes on both parent and child', 'FOO=1 enigma run -- time printenv OPENAI_API_KEY'],
      ['assignment before the bundled-CLI form', 'FOO=1 node /plugin/dist/cli.mjs run -- printenv OPENAI_API_KEY'],
      ['prefix on a nested enigma run', 'enigma run -- FOO=1 enigma run -- env'],
    ])('denies: %s', (_label, command) => {
      expect(isDenied(bash(command))).toBe(true);
    });

    it.each<[string, string]>([
      ['assignment before an ordinary command', 'FOO=1 npm run dev'],
      ['time before an ordinary command', 'time npm test'],
      ['command -v lookup', 'command -v printenv'],
      ['assignment before enigma run, ordinary child', 'FOO=1 enigma run -- npm run dev'],
      ['prefix on an ordinary enigma run child', 'enigma run -- FOO=1 npm run dev'],
      ['only assignments, no command', 'FOO=1 BAR=2'],
      ['assignment before an ordinary enigma subcommand', 'FOO=1 enigma list'],
      ['assignment before echoing an untracked name', 'FOO=1 echo $HOME'],
    ])('allows: %s', (_label, command) => {
      expect(isDenied(bash(command))).toBe(false);
    });

    // Decision recorded in Issue #96: only NAME=value, `time` and `command` are
    // skipped. These wrap the command in something that takes its own options,
    // which would make this a shell parser. Pinned, not silently missed, exactly
    // like the `sh -c` gap above.
    it('does not strip sudo, npx or nohup (accepted gap)', () => {
      expect(isDenied(bash('sudo printenv OPENAI_API_KEY'))).toBe(false);
      expect(isDenied(bash('npx printenv OPENAI_API_KEY'))).toBe(false);
      expect(isDenied(bash('nohup printenv OPENAI_API_KEY'))).toBe(false);
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
