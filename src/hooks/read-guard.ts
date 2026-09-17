// PreToolUse read-guard (D3.3, S3.2, ADR-004): denies tool calls that would read a
// secret value outside Enigma's own request/reveal/run flow. Table-driven on
// purpose — the false-positive cost is high (a guard that blocks ordinary work
// gets disabled, and then it protects nothing), so every rule below is narrow and
// the default is allow (no output at all; Claude Code proceeds normally).
//
// What this guard actually is, stated plainly rather than implied: it stops an
// agent from reading a secret BY ACCIDENT — grepping the repo, catting a .env
// file, echoing a variable it doesn't realize is tracked. It is not a sandbox
// and it does not stop an agent that is deliberately trying to read a value.
// Shell word-splitting (`${IFS}`) and ANSI-C quoting (`$'...'`) are normalized
// before matching because they're cheap and the first things anyone probes,
// but variable indirection, `eval` of an assembled string, writing a script
// and running it, or reading through an interpreter (python/node/perl) are
// not chased, and cannot be without turning this into a shell parser. Nor is
// a rename-then-read through the small non-reading-verb allowlist below
// (`mv .env safe && cat safe`): `mv`/`rm`/`touch`/etc. (the exact set is
// NON_READING_BASH_VERBS below) are allowed on a `.env` path because they're
// lifecycle operations, not reads, but nothing here tracks a file's identity
// across two separate commands, so the renamed copy's new name is just an
// ordinary path to every later rule. (`cp` and encode/decode commands like
// `base64`/`tar` are NOT in that gap — they aren't in the allowlist, so
// `cp .env x` and `base64 .env` are both still denied on the `.env`
// argument itself, before a second command ever runs.) The
// PostToolUse tripwire is the second layer, but only for secrets Enigma
// already tracks, and only when the value is actually printed somewhere in
// tool output — a `source`/`.`-style load into the current shell surfaces in
// NEITHER layer, because nothing is printed for the tripwire to scan (the
// read-guard's own deny is the only thing standing between that command and
// the shell, which is why it's denied outright rather than left to the
// tripwire). This is deliberately not a closed system: a control that
// overstates itself is worse than one that states its limits, because people
// stop compensating for what it misses.
//
// This module never touches a secret VALUE — only secret NAMES (to recognize
// `echo $NAME`) and file paths. Names are safe to inspect freely per the glossary.
//
// A `key=value` argument (`dd if=.env`, `awk -f=.env`, `python3 --file=.env`,
// `somecmd -o=.env`) is checked on the value half, not just the whole token —
// see `tokenTargetsPath` (Issue #46). This is deliberately uniform rather than
// enumerating which keys ("if", "-f", "--file") mean "read this file" for
// which command, because that enumeration is exactly what table-driven is
// avoiding, and it would still miss the next command's own option name. The
// accepted cost: an argument that merely assigns a `.env`-looking string to a
// variable — `make VAR=.env`, `FOO=.env some-command` — denies too, even
// though nothing there necessarily reads the file's contents. That's judged
// worth it: this guard already denies on the .env argument to `cp`, `base64`,
// `tar`, and every other non-allowlisted command regardless of whether that
// specific invocation would actually read the bytes (see the `cp`/encode
// paragraph above), so treating a `key=value` argument the same way is
// consistent with the guard's existing stance, not a new one.
//
// Round 2 (Issue #46): the value half is checked against EVERY `=` in the
// token, not just the first (`a=b=.env` hid `.env` behind a second `=`), so
// correctness no longer depends on an extra `=` happening to land somewhere
// `equalsSuffixes` wouldn't reach. `$'...'`/`${IFS}` reach this same check
// for free, since `normalizeShellEscapes` already runs on the whole command
// before tokenization. What's still deliberately not chased, same as before:
// a bare backslash escape outside of `$'...'` (`if=\.env`) — see
// `tokenTargetsPath`'s comment for why, and the pinned test for the decision.
//
// Round 3 (Issue #46): round 2 fixed value-side quoting with a value-side
// `stripEdgeQuotes` helper, but that only patched the symptom — `cat
// ''.env`/`cat .en''v` (quote-splicing on a BARE path, no `=` involved at
// all) proved the defect was in `tokenize` itself, which only ever stripped
// a quote character sitting at a token's own first/last position, so a
// quoted span glued onto bare text with no space (`''`, `.en''v`) left its
// quote characters stuck in the middle, unremoved. `tokenize` now resolves
// every quote span inline, wherever it falls in the token — see its own
// comment for the full reasoning, the caller-by-caller check that none of
// them wanted quote marks preserved, and the two decisions this required
// (an unmatched quote mark, and a filename that genuinely contains a quote
// character). `stripEdgeQuotes` is gone; `tokenize` already hands
// `tokenTargetsPath` a clean value now.
//
// Round 4 (Issue #48): round 3 fixed quote resolution inside `tokenize`, but
// `splitSegments` — which runs BEFORE `tokenize`, cutting the raw command
// into segments on `;`/`&`/`|`/`&&`/`||` — was still a blind
// `.split(/\|\||&&|[|;&]/)` with no quote awareness at all. A standalone
// quoted separator token placed right after a command name (`echo ';'
// $SECRET`, real bash: one `echo` invocation with two arguments, the literal
// `;` and the secret value) was sliced by the blind split into two fragments
// — one with the command name and no target, one with the target and no
// command name — so a rule keyed to a fragment's `head` token
// (`segmentEchoesKnownSecret`'s `head === 'echo'` check, in particular)
// never saw the fragment holding the actual secret reference. Confirmed as a
// live, functioning bypass against the built hook binary before this fix:
// `echo ';' $NAME`/`echo '&' $NAME`/`echo '|' $NAME` all printed the secret
// and were allowed. `splitSegments` now shares `tokenize`'s own quote-pairing
// logic (extracted into `matchQuoteSpan`, one implementation instead of two)
// so a separator inside a matched quote span is left as a literal, the same
// direction `tokenize` already treats quoting. The `.env`-by-path rules and
// the bare `env`/`printenv` rule were checked against the pre-fix binary too
// and were NOT independently vulnerable to this shape — see the pinned test
// for why (a structural difference in what each rule checks, not luck) —
// and the `enigma get`/`security find-generic-password`/`op read` rules,
// which check an exact `head`+next-token pair, can still be evaded by the
// same shape but only in a way that also breaks the target CLI's own
// argument parsing (also pinned, as a deliberate non-fix: the guard's parse
// is accurate to what real bash hands that process, and PR #32's boundary is
// that a command which doesn't work isn't a bypass worth chasing). Verified
// concretely for `enigma get`, not just asserted: `src/cli/index.ts`'s
// `main()` destructures `argv` into `[command, ...rest]` and dispatches via
// `COMMANDS[command]`, keyed on `argv[0]` alone — so `enigma ';' get NAME`
// looks up `COMMANDS[';']`, finds nothing, and prints the "unknown command"
// usage error (exit 2) without `cmdGet` ever running. The displaced head
// breaks Enigma's own real dispatch the same way it breaks the guard's
// parse of it, not just in theory.
//
// THE RULE TAXONOMY. Given correct segmentation, every rule above falls into
// one of two structurally different buckets, and which bucket a rule is in
// is what actually decided whether rounds 1-4 could reach it. A SCAN rule —
// `segmentTargetsDotEnvByPath`'s `.env`-by-path check,
// `segmentTargetsEnigmaConfigByPath`'s config-path check, and the regex scan
// half of `segmentEchoesKnownSecret` that looks for a tracked name anywhere
// in the segment — examines every remaining token in a segment regardless of
// position, so over-splitting can only move a target INTO some fragment's
// scanned set, never out of it: the safe direction. A HEAD rule —
// `segmentIsBareEnvDump`, `segmentIsEnigmaGetOrEnv`, `segmentIsKeychainRead`,
// `segmentIsOpRead`, and the `head === 'echo'` gate half of
// `segmentEchoesKnownSecret` — keys on a fragment's first token (or first
// two, for the exact-subcommand rules), while the dangerous reference lives
// in separately-displaceable text elsewhere in the command; a bad split can
// relocate that text to a fragment whose head no longer matches, and neither
// resulting fragment then satisfies the rule. "Over-splitting tends toward
// over-denial" is true of every scan rule here and false of every head rule
// — that is the load-bearing distinction, not a detail. Round 4 is what
// happens when it isn't made explicit: an independent reviewer reasoned
// "more fragments, more scanning, more denial" from `splitSegments`, correct
// for most of this file (the scan rules, and the two `.env`/`printenv` cases
// pinned as NOT independently vulnerable), and `echo ';' $NAME` — half scan,
// half head, on the `head === 'echo'` side — was the one case it didn't hold
// for. Note that `segmentEchoesKnownSecret` is both at once: over-splitting
// is safe for what its regex scans for, and unsafe for the `echo` gate that
// decides whether the scan runs at all. A rule doesn't have to be purely one
// kind to be exposed by the head half.
//
// Four rounds, one shape each time: correctness depending on incidental
// syntax the guard hadn't actually normalized (a slash, a quote's position,
// an `=`'s position, a quote character's position, a separator's position
// relative to a quote span) rather than on anything it deliberately declined
// to chase. Read the pinned tests before changing this file again — they are
// what actually got probed to find rounds 2 through 4.
import { basename, resolve, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { enigmaHome } from '../core/paths.js';
import { readIndex } from '../core/index-store.js';
import type { PreToolUseInput, PreToolUseOutput } from './types.js';

const DOTENV_EXEMPT = new Set(['.env.example']);
const BARE_ENV_DUMP_COMMANDS = new Set(['env', 'printenv']);
/** Commands that touch a .env path without reading its content into this
 * session (metadata/lifecycle operations, or existence checks) — referencing
 * `.env` as an argument to one of these is not a leak. */
const NON_READING_BASH_VERBS = new Set(['rm', 'mv', 'touch', 'chmod', 'stat', 'ls', 'find', 'test']);
/** A recursive Grep needs its own `.env` exclusion (see `grepDotEnvExclusion`);
 * this is the pattern injected via `updatedInput.glob`. */
const DOTENV_EXCLUDE_GLOB = '!.env*';
/** Bounds how deep `$(...)`/`` `...` `` command-substitution unwrapping goes.
 * Generous on purpose — this is recursion over a short string, so the cost of
 * going deeper is negligible, and nesting this deep essentially never happens
 * in an ordinary command. Exceeding it denies (see `allCommandTexts`) rather
 * than silently checking only a partial unwrapping. */
const MAX_SUBSTITUTION_DEPTH = 10;

const USE_INSTEAD = 'Use `enigma_request` to collect it from the user, or `enigma run -- <command>` to inject the real value into a child process without it ever entering this session.';

function isDotEnvBasename(name: string): boolean {
  if (DOTENV_EXEMPT.has(name)) return false;
  return name === '.env' || name.startsWith('.env.');
}

function targetsDotEnv(pathLike: string): boolean {
  return isDotEnvBasename(basename(pathLike.trim()));
}

function targetsEnigmaConfig(pathLike: string, cwd: string): boolean {
  const home = resolve(enigmaHome());
  const resolved = resolve(cwd, pathLike.trim());
  return resolved === home || resolved.startsWith(`${home}${sep}`);
}

/**
 * Decodes ANSI-C escapes inside a `$'...'` body (the syntax bash itself uses
 * for that quoting form): `\xHH` hex, `\nnn` octal, `\uHHHH`/`\UHHHHHHHH`
 * unicode, and the common single-character escapes (`\n`, `\t`, `\\`, …).
 * Used to catch a `.env` reference spelled out byte-by-byte specifically to
 * dodge a plain-text match, e.g. `$'\x2e\x65\x6e\x76'` for `.env`.
 */
function decodeAnsiCEscapes(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|.)/gs, (_whole, esc: string) => {
    if (esc.startsWith('x')) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc.startsWith('u') || esc.startsWith('U')) return String.fromCodePoint(parseInt(esc.slice(1), 16));
    if (/^[0-7]{1,3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    switch (esc) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'a':
        return '\x07';
      case 'b':
        return '\b';
      case 'e':
      case 'E':
        return '\x1b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      default:
        return esc;
    }
  });
}

/**
 * Expands the two shell mechanisms most likely to be reached for first when
 * routing around a naive tokenizer, applied once up front to the whole
 * command (including inside `$(...)`/`` `...` `` spans, since substitution
 * extraction runs on the result) so every rule below benefits without each
 * one re-implementing this:
 *
 * - `${IFS}`/bare `$IFS` — IFS defaults to space/tab/newline, so in real bash
 *   an UNQUOTED `cat${IFS}.env` word-splits into `cat .env` exactly like a
 *   literal space would. This function has no quote tracking at all, though
 *   — it runs over the whole command text regardless of single/double quotes
 *   — so it also rewrites `${IFS}` inside a single-quoted string, where bash
 *   itself would never expand it. That's a deliberate, accepted trade: the
 *   failure direction is an occasional denial of a quoted literal that
 *   merely looks like `cat${IFS}.env` once collapsed (e.g.
 *   `echo '${IFS}.env'`), never a bypass. Tracking quote context correctly
 *   means re-implementing shell quoting, which trades a working guard for
 *   one that can fail open instead of closed — see `test/unit/hooks/
 *   read-guard.test.ts` for the pinned false-positive case.
 * - `$'...'` ANSI-C quoting — decoded via `decodeAnsiCEscapes`, then
 *   re-wrapped in double quotes (escaping `\` and `"` in the decoded text)
 *   so `tokenize`'s existing quote handling treats it as one word, the same
 *   as bash would.
 */
function normalizeShellEscapes(command: string): string {
  const withIfsExpanded = command.replace(/\$\{IFS\}|\$IFS\b/g, ' ');
  return withIfsExpanded.replace(/\$'((?:[^'\\]|\\.)*)'/gs, (_whole, body: string) => {
    const decoded = decodeAnsiCEscapes(body);
    const escaped = decoded.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
}

/**
 * If `text[i]` is a quote character (`'` or `"`) that has a matching close
 * quote somewhere ahead in `text` (searched from `i + 1`), returns the index
 * immediately after that close quote. Returns `undefined` when `text[i]`
 * isn't a quote character, or is one with no matching close anywhere ahead —
 * an unmatched quote mark is never treated as an unterminated span that
 * swallows the rest of `text`; every caller falls through and treats it as
 * an ordinary literal character instead, the same "mis-parse toward allow"
 * direction used everywhere else in this file.
 *
 * This is the one place quote-pairing is decided. Both `tokenize` (which
 * resolves a span to its inner text) and `splitSegments` (which only needs
 * to know a span exists, so a `;`/`&`/`|` inside it isn't mistaken for a
 * real command separator) call this instead of each re-implementing their
 * own pairing rule — two implementations of the same rule is exactly what
 * drifted apart before (`tokenize` gained real quoting in Issue #46 round 3
 * while `splitSegments` stayed a blind regex split, which is what Issue #48
 * turned out to be).
 *
 * The two callers slice the result differently, and that's intentional, not
 * a leftover inconsistency: `tokenize` takes `segment.slice(i + 1, spanEnd -
 * 1)`, the content BETWEEN the quote characters, because it needs the
 * dequoted word for matching. `splitSegments` takes `command.slice(i,
 * spanEnd)`, the WHOLE span including both quote characters, because it
 * never dequotes anything — it only needs to skip the span atomically so
 * nothing inside it is mistaken for a separator; dequoting is still
 * `tokenize`'s job, downstream, once a segment has already been chosen. Same
 * pairing rule, two different uses of what it finds.
 *
 * THE SEGMENTATION INVARIANT this gives `splitSegments`: in its loop, the
 * `matchQuoteSpan` check at each position runs BEFORE the separator check
 * (`matchSeparatorAt`), so whenever a span here pairs successfully, every
 * character inside it — separators included — is consumed by the quote
 * branch in one step and `matchSeparatorAt` never sees any of them. A quote
 * span that pairs can therefore never straddle a segment boundary. The only
 * way a quote character ends up split across two segments is when it has no
 * matching close anywhere ahead — `matchQuoteSpan` returns `undefined` for
 * that, by design (see above) — and a real separator after it splits
 * normally; that's the accepted "mis-parse toward allow" case, not a
 * violation of this invariant.
 */
function matchQuoteSpan(text: string, i: number): number | undefined {
  const c = text[i];
  if (c !== '"' && c !== "'") return undefined;
  const close = text.indexOf(c, i + 1);
  return close === -1 ? undefined : close + 1;
}

/**
 * Good-enough shell tokenizer for a heuristic guard, not a full parser: splits on
 * whitespace outside quotes, and resolves every `'...'`/`"..."` span *inside* a
 * token to its inner content — wherever it appears, not only at the token's own
 * edges. `dd if=''.env` and `cat .en''v` (quote-splicing: an empty or non-empty
 * quoted span glued to bare text with no space) previously defeated every rule
 * below, because the old implementation only stripped a quote character sitting
 * at a token's very first or very last position, so a spliced-in empty `''`/`""`
 * left its two quote characters sitting in the middle of the token, unremoved
 * (Issue #46 round 3 — the same bug `stripEdgeQuotes` round 2 worked around for
 * the `key=value` value half specifically, but it turned out to be `tokenize`
 * itself that needed fixing: `cat ''.env` proved this isn't specific to
 * `key=value` parsing). Every caller of `tokenize` was checked: all of them
 * either compare the result against a known literal (`commandName(head) ===
 * 'rm'`/`'echo'`/`'enigma'`/…) or test it as a path (`targetsDotEnv`,
 * `targetsEnigmaConfig`) — real bash resolves quoting before a command ever
 * sees its own argv, so every caller wants the dequoted form; none wants the
 * original quote marks preserved.
 *
 * Quote spans are matched as real pairs via `matchQuoteSpan` (searching ahead
 * for the next matching quote character, not blindly deleting every quote
 * character in the token), so a filename that legitimately contains a quote
 * character — expressed the way bash itself requires, by switching quote types
 * (`'it'"'"'s.env'` -> `it's.env`) — is still reconstructed correctly. An
 * unmatched quote mark (malformed input, or a literal quote bash itself would
 * only accept backslash-escaped) is treated as an ordinary literal character,
 * which means a genuine `.env` reference later in the same segment is still
 * caught rather than getting absorbed into one unmatched blob. See the pinned
 * tests for both decisions. The tripwire is the backstop if a value still
 * leaks regardless.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inWord = false;
  let i = 0;
  while (i < segment.length) {
    const c = segment[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (inWord) {
        tokens.push(current);
        current = '';
        inWord = false;
      }
      i++;
      continue;
    }
    const spanEnd = matchQuoteSpan(segment, i);
    if (spanEnd !== undefined) {
      current += segment.slice(i + 1, spanEnd - 1);
      inWord = true;
      i = spanEnd;
      continue;
    }
    current += c;
    inWord = true;
    i++;
  }
  if (inWord) tokens.push(current);
  return tokens;
}

/** Matches a segment-separator operator (`||`, `&&`, `|`, `;`, `&`) starting
 * exactly at `command[i]`, checking the two-character operators first so
 * `||`/`&&` aren't mistaken for two single-character ones — the same
 * operator set and precedence as the original `/\|\||&&|[|;&]/` split
 * regex, just tested at a position instead of matched globally. */
function matchSeparatorAt(command: string, i: number): string | undefined {
  if (command[i] === '|' && command[i + 1] === '|') return '||';
  if (command[i] === '&' && command[i + 1] === '&') return '&&';
  const c = command[i];
  return c === '|' || c === ';' || c === '&' ? c : undefined;
}

/**
 * Splits `command` into segments at top-level `;`, `&`, `|`, `&&`, `||` — the
 * same operators the original blind `.split(/\|\||&&|[|;&]/)` used, but now
 * quote-aware via `matchQuoteSpan`: a separator character sitting inside a
 * matched quote span is left as a literal part of its segment, not treated
 * as a command boundary.
 *
 * Before this fix, `splitSegments` ran with zero quote awareness at all, even
 * after `tokenize` gained real quote-pair resolution (Issue #46 round 3). A
 * standalone quoted separator token placed right after a command name —
 * `echo ';' $SECRET`, `enigma ';' get NAME`, `security ';' find-generic-password
 * ...`, `op ';' read ...` — is, in real bash, one single command (the quoted
 * `;` is a literal argument, not a boundary), but the blind split cut it into
 * two fragments anyway: one with the command name and no target, one with the
 * target and no command name. Neither fragment's `head` (or `head`+second
 * token, for the rules that check both) matched what a rule needed to see, so
 * the whole command sailed through undenied while still doing exactly what
 * the rule exists to stop — confirmed live against the built hook binary
 * (`echo ';' $API_KEY` actually echoes the secret in real bash and was
 * allowed by the guard) before this fix. This is a different failure shape
 * than the `.env`-by-path rules (`segmentTargetsDotEnvByPath` and friends),
 * which check every token in a segment's `rest` regardless of position — the
 * bypass here specifically hits rules keyed to `head`, or `head`+an exact
 * next-token position, because over-splitting can relocate a target's *whole
 * fragment* to one whose head doesn't match, not just shuffle it within a
 * fragment's own token list.
 *
 * Quote characters themselves are preserved here (not stripped) — that's
 * still `tokenize`'s job once each segment is chosen; this function only
 * needs to know a quote span exists, not what's inside it. An unmatched
 * quote mark (no closing quote anywhere later in `command`) is not treated
 * as an unterminated span — same "mis-parse toward allow, never toward
 * missing a real separator" direction as `tokenize` and everywhere else in
 * this file: a separator after it still splits normally.
 *
 * Deliberately not chased here, same PR #32 boundary as the rest of this
 * file: this still isn't a shell parser, so it doesn't track `$(...)`/`` ` ``
 * nesting or backslash escapes for the purpose of deciding segment
 * boundaries (those are handled separately, before this function ever runs —
 * see `normalizeShellEscapes` and `extractSubstitutions`/`allCommandTexts`).
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let i = 0;
  while (i < command.length) {
    const spanEnd = matchQuoteSpan(command, i);
    if (spanEnd !== undefined) {
      current += command.slice(i, spanEnd);
      i = spanEnd;
      continue;
    }
    const sep = matchSeparatorAt(command, i);
    if (sep !== undefined) {
      segments.push(current);
      current = '';
      i += sep.length;
      continue;
    }
    current += command[i];
    i++;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Extracts the inner text of every `$(...)` and `` `...` `` span in `command`,
 * recursively (bounded), so `eval "$(cat .env)"` is checked the same as a
 * plain `cat .env` segment — command substitution must not be a way around
 * every other rule below. Not a shell parser: a stray unmatched backtick or
 * paren just stops that one scan early, which fails toward "allow" (missing a
 * substitution), the same safe direction as `tokenize`.
 */
function extractSubstitutions(command: string): string[] {
  const results: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] === '$' && command[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')') depth--;
        j++;
      }
      if (depth === 0) results.push(command.slice(i + 2, j - 1));
      i = j;
      continue;
    }
    if (command[i] === '`') {
      const end = command.indexOf('`', i + 1);
      if (end === -1) break;
      results.push(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  return results;
}

/**
 * Collects the command itself plus the unwrapped contents of every command
 * substitution, recursively. Returns `undefined` — never a partial result —
 * when nesting exceeds `MAX_SUBSTITUTION_DEPTH`, so an un-inspected
 * substitution is never silently treated as safe; the caller denies in that
 * case rather than falling back to "allow" on a command it couldn't fully see.
 */
function allCommandTexts(command: string, depth = MAX_SUBSTITUTION_DEPTH): string[] | undefined {
  const subs = extractSubstitutions(command);
  if (subs.length === 0) return [command];
  if (depth <= 0) return undefined;

  const nested = subs.map((s) => allCommandTexts(s, depth - 1));
  if (nested.some((n) => n === undefined)) return undefined;
  return [command, ...nested.flatMap((n) => n as string[])];
}

function commandName(token: string): string {
  const parts = token.split('/');
  return parts[parts.length - 1] ?? token;
}

/**
 * Every substring of `token` starting right after an `=`, one per `=` in the
 * token — not just the first. `a=b=.env` must be checked as both `"b=.env"`
 * and `".env"`, not only the first split, or a second `=` hides a dotenv
 * value behind an arbitrary key of its own (Issue #46 round 2). No quote
 * handling needed here any more: `tokenize` now fully resolves quoting
 * before this ever runs (Issue #46 round 3), so a suffix like `.env` from
 * `if='.env'` already arrives clean.
 */
function equalsSuffixes(token: string): string[] {
  const suffixes: string[] = [];
  let idx = token.indexOf('=');
  while (idx !== -1) {
    suffixes.push(token.slice(idx + 1));
    idx = token.indexOf('=', idx + 1);
  }
  return suffixes;
}

/**
 * True when `token` — or, split on any `=` it contains, the text following it
 * — is a path `isTarget` cares about (Issue #46). `dd if=.env`, `awk
 * -f=.env`, `python3 --file=.env`, and `somecmd -o=.env` all name a target
 * file using the same `key=value` shape a plain `VAR=.env` assignment-style
 * argument uses, and there is no way to tell "this key means read a file"
 * from "this key is just a variable name" from the token text alone — see
 * the top-of-file comment for why this checks the value uniformly rather
 * than trying to special-case dd/awk/etc.'s specific option names (that's
 * the enumeration this guard is deliberately table-driven to avoid). The
 * whole-token form is still skipped for anything starting with `-`, since a
 * bare flag like `-f` is never itself a path.
 *
 * What this deliberately does NOT chase, same boundary as the rest of this
 * file (PR #32's ruling): a backslash used to escape a character outside of
 * `$'...'` (`if=\.env` — bash would read this as `if=.env`, but nothing in
 * this file un-escapes a bare backslash; only `$'...'` bodies are decoded,
 * via `decodeAnsiCEscapes`/`normalizeShellEscapes`, which already runs on
 * the whole command before this point, so a `$'...'`-quoted value still
 * matches). Un-escaping bare backslashes generally would mean re-implementing
 * shell escaping, the same trade already declined for `normalizeShellEscapes`
 * — see its comment. Pinned as a known, accepted gap in
 * `test/unit/hooks/read-guard.test.ts`, not silently missed.
 */
function tokenTargetsPath(token: string, isTarget: (value: string) => boolean): boolean {
  if (equalsSuffixes(token).some((suffix) => isTarget(suffix))) return true;
  return !token.startsWith('-') && isTarget(token);
}

/** Target-based, not utility-gated: ANY command referencing a `.env` path as a
 * non-flag argument (or the value half of a `key=value` argument — see
 * `tokenTargetsPath`) is denied, whatever that command is (`less`, `xxd`,
 * `strings`, `source`, `.` …) — except the small allowlist of commands that
 * touch the file without reading its content into this session. */
function segmentTargetsDotEnvByPath(segment: string): boolean {
  const [head, ...rest] = tokenize(segment);
  if (head && NON_READING_BASH_VERBS.has(commandName(head))) return false;
  return rest.some((t) => tokenTargetsPath(t, targetsDotEnv));
}

function segmentTargetsEnigmaConfigByPath(segment: string, cwd: string): boolean {
  const [head, ...rest] = tokenize(segment);
  if (!head) return false;
  return rest.some((t) => tokenTargetsPath(t, (value) => targetsEnigmaConfig(value, cwd)));
}

function segmentIsBareEnvDump(segment: string): boolean {
  const [head] = tokenize(segment);
  return head !== undefined && BARE_ENV_DUMP_COMMANDS.has(commandName(head));
}

function segmentIsEnigmaGetOrEnv(segment: string): boolean {
  const [head, sub] = tokenize(segment);
  return commandName(head ?? '') === 'enigma' && (sub === 'get' || sub === 'env');
}

function segmentIsKeychainRead(segment: string): boolean {
  const [head, sub] = tokenize(segment);
  return commandName(head ?? '') === 'security' && sub === 'find-generic-password';
}

function segmentIsOpRead(segment: string): boolean {
  const [head, sub] = tokenize(segment);
  return commandName(head ?? '') === 'op' && sub === 'read';
}

/** Names Enigma actually tracks, from every scope — a bare `echo $NAME` is only
 * denied when NAME is a real secret name, so ordinary env var echoes are unaffected. */
function knownSecretNames(): Set<string> {
  return new Set(readIndex().entries.map((e) => e.name));
}

function segmentEchoesKnownSecret(segment: string, known: Set<string>): string | undefined {
  const [head] = tokenize(segment);
  if (commandName(head ?? '') !== 'echo') return undefined;
  const matches = [...segment.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map((m) => m[1]);
  return matches.find((name): name is string => name !== undefined && known.has(name));
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const PATH_TOOL_FIELDS: Record<string, string[]> = {
  Read: ['file_path'],
  Grep: ['path', 'glob'],
  Glob: ['path', 'pattern'],
};

/** True when `pathLike` is known, right now, to name an existing non-directory
 * (a specific file) — in which case a Grep glob filter wouldn't even apply
 * (ripgrep searches an explicit file target directly, ignoring `--glob`), so
 * there's nothing for `grepDotEnvExclusion` to usefully add. Anything else
 * (omitted, a directory, or a path that doesn't exist yet) is treated as a
 * recursive search and gets the exclusion, which is the safe default. */
function isKnownNonDirectoryPath(pathLike: string | undefined, cwd: string): boolean {
  if (!pathLike) return false;
  try {
    const resolved = resolve(cwd, pathLike.trim());
    return existsSync(resolved) && !statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

/** Representative `.env`-family basenames to probe a glob against — real
 * filenames, not pattern-syntax reasoning, per the "match against the real
 * filenames" principle: `.env.example` is deliberately excluded, since that
 * file is safe to search and a glob that only reaches it is not dangerous. */
const DOTENV_PROBE_BASENAMES = ['.env', '.env.local', '.env.production', '.env.development', '.env.test', '.env.staging'];

/** Expands one level of `{a,b,c}` brace groups (recursively, so nested groups
 * work) into every concrete alternative, e.g. `.env.{local,production}` ->
 * [".env.local", ".env.production"] — needed so a glob like that is matched
 * against real names instead of literal, always-failing brace characters. */
function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]*)\}/);
  if (!match || match.index === undefined) return [pattern];
  const whole = match[0];
  const inner = match[1] ?? '';
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + whole.length);
  return inner.split(',').flatMap((option) => expandBraces(`${prefix}${option}${suffix}`));
}

/** Converts one glob alternative (no braces, no leading `!`) to a RegExp: `**`
 * crosses `/`, `*` and `?` don't, a `[...]` bracket class is carried through
 * almost verbatim (glob's `[!...]` negation becomes regex's `[^...]`), and
 * everything else is escaped. */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
      } else {
        const body = glob.slice(i + 1, close);
        out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        i = close;
      }
    } else if (c && '.+^${}()|\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether `glob` (as ripgrep's `--glob` would interpret it) could match any
 * real `.env`-family file, decided empirically against `DOTENV_PROBE_BASENAMES`
 * rather than by reasoning about glob syntax in the abstract — `*.ts`,
 * `**\/*.json`, and `*.[jt]s` cannot, `.env`, `.env*`, `*`, `**`, and `**\/*`
 * all can. A leading `!` (ripgrep negation) is stripped before testing.
 */
function globCouldMatchDotEnv(glob: string): boolean {
  const pattern = glob.startsWith('!') ? glob.slice(1) : glob;
  const hasSlash = pattern.includes('/');
  return expandBraces(pattern).some((alt) => {
    const regex = globToRegExp(alt);
    return DOTENV_PROBE_BASENAMES.some((name) => regex.test(name) || (hasSlash && regex.test(`some/dir/${name}`)));
  });
}

/**
 * Grep recurses over a directory by default, and the per-path checks above
 * only catch a call that names a `.env` file directly — the common miss is
 * `Grep(pattern, path: ".")`, which walks straight through `.env` with no
 * Bash involved at all. Adding a `.env*` exclusion glob is a no-op when
 * nothing under `path` matches it, so it's added unconditionally for any
 * directory-rooted (or omitted-path) search rather than first checking
 * whether a `.env` actually exists there.
 *
 * The one case this can't rewrite: ripgrep's `--glob` takes one pattern per
 * flag, and the Grep tool only exposes a single `glob` string, so there is no
 * way to express "this include AND that exclude" in the same field. When the
 * caller already set `glob`, whether that's a problem depends on whether the
 * existing filter could reach a `.env` file at all: `*.ts` or `**\/*.json`
 * can't, so denying "search every TypeScript file for X" to protect a file
 * that filter could never match anyway would be exactly the kind of
 * false-positive that gets a guard switched off. Only a glob that could
 * actually match `.env*` (or is unrestrictive, like `*` or `**`) falls back
 * to deny.
 */
function grepDotEnvExclusion(toolInput: Record<string, unknown>, cwd: string): PreToolUseOutput | undefined {
  if (isKnownNonDirectoryPath(stringField(toolInput, 'path'), cwd)) return undefined;

  const existingGlob = stringField(toolInput, 'glob');
  if (existingGlob) {
    if (!globCouldMatchDotEnv(existingGlob)) return undefined;
    return deny(
      `This Grep call already filters by --glob "${existingGlob}", which could still reach a .env file and can't be safely combined with an additional exclusion in the same call. Narrow --glob to exclude .env files yourself, or use \`enigma list\`/\`enigma doctor\` if you're looking for what Enigma has stored.`,
    );
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Added a glob exclusion for .env files so this search can proceed without exposing a secret value in its results.',
      updatedInput: { ...toolInput, glob: DOTENV_EXCLUDE_GLOB },
    },
  };
}

/**
 * Rules 1-2 inspect the tool's own structured input (file paths, patterns) for
 * Read/Grep/Glob, followed by Grep's directory-search exclusion. Rules 3+
 * inspect the Bash command string (including inside command substitution).
 * Order doesn't matter for the Bash rules — each is independent and the first
 * match wins.
 */
export function runReadGuard(input: PreToolUseInput): PreToolUseOutput | undefined {
  const cwd = input.cwd ?? process.cwd();
  const toolInput = input.tool_input ?? {};

  if (input.tool_name === 'Read' || input.tool_name === 'Grep' || input.tool_name === 'Glob') {
    const fields = PATH_TOOL_FIELDS[input.tool_name] ?? [];
    const candidates = fields.map((f) => stringField(toolInput, f)).filter((v): v is string => v !== undefined);

    for (const candidate of candidates) {
      if (targetsDotEnv(candidate)) {
        return deny(`Reading .env files directly is blocked to keep secret values out of this session. ${USE_INSTEAD}`);
      }
      if (targetsEnigmaConfig(candidate, cwd)) {
        return deny(
          "Enigma's config directory holds the encrypted vault, index, and audit log. Use `enigma list` or `enigma doctor` instead of reading it directly.",
        );
      }
    }

    if (input.tool_name === 'Grep') {
      const exclusion = grepDotEnvExclusion(toolInput, cwd);
      if (exclusion) return exclusion;
    }
  }

  if (input.tool_name === 'Bash') {
    const command = stringField(toolInput, 'command');
    if (command) {
      const known = knownSecretNames();
      const texts = allCommandTexts(normalizeShellEscapes(command));
      if (texts === undefined) {
        return deny(
          'This command has command-substitution nesting too deep to safely inspect for a secret read. Simplify it, or use `enigma run -- <command>` if it needs a secret value injected.',
        );
      }
      const segments = texts.flatMap(splitSegments);
      for (const segment of segments) {
        if (segmentTargetsDotEnvByPath(segment)) {
          return deny(`Reading .env files directly is blocked to keep secret values out of this session. ${USE_INSTEAD}`);
        }
        if (segmentTargetsEnigmaConfigByPath(segment, cwd)) {
          return deny(
            "Enigma's config directory holds the encrypted vault, index, and audit log. Use `enigma list` or `enigma doctor` instead of reading it directly.",
          );
        }
        if (segmentIsBareEnvDump(segment)) {
          return deny(
            `\`env\`/\`printenv\` can dump secret values into this session. Use \`enigma list\` to see which names exist, or \`enigma run -- <command>\` to run a command with the real values injected without you seeing them.`,
          );
        }
        if (segmentIsEnigmaGetOrEnv(segment)) {
          return deny(
            `\`enigma get\`/\`enigma env\` print a secret value to stdout for humans and scripts, not for the agent. ${USE_INSTEAD}`,
          );
        }
        if (segmentIsKeychainRead(segment)) {
          return deny(`Reading the macOS Keychain directly via \`security find-generic-password\` is blocked. ${USE_INSTEAD}`);
        }
        if (segmentIsOpRead(segment)) {
          return deny(`Reading a 1Password item directly via \`op read\` is blocked. ${USE_INSTEAD}`);
        }
        const echoedName = segmentEchoesKnownSecret(segment, known);
        if (echoedName) {
          return deny(
            `${echoedName} is a secret Enigma tracks; echoing it would put the value in this session. Use \`enigma run -- <command>\` to inject it into a child process instead.`,
          );
        }
      }
    }
  }

  return undefined;
}

function deny(reason: string): PreToolUseOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
