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
// (`mv .env safe && cat safe`): `mv`/`cp`/etc. are allowed on a `.env` path
// because they're lifecycle operations, not reads, but nothing here tracks a
// file's identity across two separate commands, so the renamed copy's new
// name is just an ordinary path to every later rule. (`cp` and encode/decode
// commands like `base64`/`tar` are NOT in that gap — they aren't in the
// allowlist, so `cp .env x` and `base64 .env` are both still denied on the
// `.env` argument itself, before a second command ever runs.) The
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

/** Good-enough shell tokenizer for a heuristic guard, not a full parser: splits on
 * whitespace, keeping a `"quoted"` or `'quoted'` run as one token, then strips one
 * layer of matching quotes. A guard that mis-parses toward "allow" is the safe
 * failure direction here — the tripwire is the backstop if a value still leaks. */
function tokenize(segment: string): string[] {
  const raw = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return raw.map((t) => t.replace(/^["']|["']$/g, ''));
}

function splitSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;&]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

/** Target-based, not utility-gated: ANY command referencing a `.env` path as a
 * non-flag argument is denied, whatever that command is (`less`, `xxd`,
 * `strings`, `source`, `.` …) — except the small allowlist of commands that
 * touch the file without reading its content into this session. */
function segmentTargetsDotEnvByPath(segment: string): boolean {
  const [head, ...rest] = tokenize(segment);
  if (head && NON_READING_BASH_VERBS.has(commandName(head))) return false;
  return rest.some((t) => !t.startsWith('-') && targetsDotEnv(t));
}

function segmentTargetsEnigmaConfigByPath(segment: string, cwd: string): boolean {
  const [head, ...rest] = tokenize(segment);
  if (!head) return false;
  return rest.some((t) => !t.startsWith('-') && targetsEnigmaConfig(t, cwd));
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
