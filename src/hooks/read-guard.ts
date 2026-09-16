// PreToolUse read-guard (D3.3, S3.2, ADR-004): denies tool calls that would read a
// secret value outside Enigma's own request/reveal/run flow. Table-driven on
// purpose — the false-positive cost is high (a guard that blocks ordinary work
// gets disabled, and then it protects nothing), so every rule below is narrow and
// the default is allow (no output at all; Claude Code proceeds normally).
//
// This module never touches a secret VALUE — only secret NAMES (to recognize
// `echo $NAME`) and file paths. Names are safe to inspect freely per the glossary.
import { basename, resolve, sep } from 'node:path';
import { enigmaHome } from '../core/paths.js';
import { readIndex } from '../core/index-store.js';
import type { PreToolUseInput, PreToolUseOutput } from './types.js';

const DOTENV_EXEMPT = new Set(['.env.example']);
const DOTENV_UTILITIES = new Set(['cat', 'grep', 'sed', 'awk', 'head', 'tail']);
const BARE_ENV_DUMP_COMMANDS = new Set(['env', 'printenv']);

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

function commandName(token: string): string {
  const parts = token.split('/');
  return parts[parts.length - 1] ?? token;
}

function segmentTargetsDotEnvViaUtility(segment: string): boolean {
  const [head, ...rest] = tokenize(segment);
  if (!head || !DOTENV_UTILITIES.has(commandName(head))) return false;
  return rest.some((t) => !t.startsWith('-') && targetsDotEnv(t));
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

function segmentTargetsEnigmaConfigViaUtility(segment: string, cwd: string): boolean {
  const [head, ...rest] = tokenize(segment);
  if (!head) return false;
  return rest.some((t) => !t.startsWith('-') && targetsEnigmaConfig(t, cwd));
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

/**
 * Rules 1-2 inspect the tool's own structured input (file paths, patterns) for
 * Read/Grep/Glob. Rules 3+ inspect the Bash command string. Order doesn't matter —
 * each rule is independent and the first match wins.
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
  }

  if (input.tool_name === 'Bash') {
    const command = stringField(toolInput, 'command');
    if (command) {
      const known = knownSecretNames();
      for (const segment of splitSegments(command)) {
        if (segmentTargetsDotEnvViaUtility(segment)) {
          return deny(`Reading .env files directly is blocked to keep secret values out of this session. ${USE_INSTEAD}`);
        }
        if (segmentTargetsEnigmaConfigViaUtility(segment, cwd)) {
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
