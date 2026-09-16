// PreToolUse read-guard (D3.3, S3.2, ADR-004): denies tool calls that would read a
// secret value outside Enigma's own request/reveal/run flow. Table-driven on
// purpose — the false-positive cost is high (a guard that blocks ordinary work
// gets disabled, and then it protects nothing), so every rule below is narrow and
// the default is allow (no output at all; Claude Code proceeds normally).
//
// This module never touches a secret VALUE — only secret NAMES (to recognize
// `echo $NAME`) and file paths. Names are safe to inspect freely per the glossary.
//
// Known, accepted gap: a copy-then-read (`cp .env x && cat x`) defeats every
// filename heuristic here, since the second command never mentions `.env`. The
// PostToolUse tripwire is the only backstop, and only for secrets Enigma
// already tracks — this guard cannot and does not chase that pattern.
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
/** Bounds how deep `$(...)`/`` `...` `` command-substitution unwrapping goes,
 * so a pathological command can't recurse unboundedly. */
const MAX_SUBSTITUTION_DEPTH = 3;

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

function allCommandTexts(command: string, depth = MAX_SUBSTITUTION_DEPTH): string[] {
  if (depth <= 0) return [command];
  const subs = extractSubstitutions(command);
  return [command, ...subs.flatMap((s) => allCommandTexts(s, depth - 1))];
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

/**
 * Grep recurses over a directory by default, and the per-path checks above
 * only catch a call that names a `.env` file directly — the common miss is
 * `Grep(pattern, path: ".")`, which walks straight through `.env` with no
 * Bash involved at all. Adding a `.env*` exclusion glob is a no-op when
 * nothing under `path` matches it, so it's added unconditionally for any
 * directory-rooted (or omitted-path) search rather than first checking
 * whether a `.env` actually exists there.
 *
 * The one case this can't handle: ripgrep's `--glob` takes one pattern per
 * flag, and the Grep tool only exposes a single `glob` string, so there is no
 * way to express "this include AND that exclude" in the same field. When the
 * caller already set `glob`, this falls back to deny rather than silently
 * dropping the caller's filter or guessing whether it would have matched
 * `.env` anyway.
 */
function grepDotEnvExclusion(toolInput: Record<string, unknown>, cwd: string): PreToolUseOutput | undefined {
  if (isKnownNonDirectoryPath(stringField(toolInput, 'path'), cwd)) return undefined;

  const existingGlob = stringField(toolInput, 'glob');
  if (existingGlob) {
    return deny(
      `This Grep call already filters by --glob "${existingGlob}", which can't be safely combined with an exclusion for .env files in the same call. Retry without --glob, or use \`enigma list\`/\`enigma doctor\` if you're looking for what Enigma has stored.`,
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
      const segments = allCommandTexts(command).flatMap(splitSegments);
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
