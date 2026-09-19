import type { Scope } from '../core/index-store.js';

/** Thrown for CLI usage mistakes (bad flags, missing args); maps to exit code 2. */
export class UsageError extends Error {}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface ParseSpec {
  /** Flags that consume the following argument as a value: `--flag VALUE` or `--flag=VALUE`. */
  value?: string[];
  /** Flags that are present/absent only: `--flag`. The `--flag=VALUE` form is also accepted for booleans (Issue #22, AC #4): only `true|false|yes|no|0|1` (case-insensitive) are valid values; everything else throws UsageError. */
  boolean?: string[];
}

/** Minimal hand-rolled flag parser — no positional/flag interleaving beyond `--name value` and `--name=value`. */
export function parseArgs(argv: string[], spec: ParseSpec = {}): ParsedArgs {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf('=');
    const rawName = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
    if (valueFlags.has(rawName)) {
      if (eqIdx !== -1) {
        flags[rawName] = arg.slice(eqIdx + 1);
        continue;
      }
      const next = argv[i + 1];
      // A value flag's value must not begin with `--` — that's almost certainly the next
      // flag (a missing-value typo like `--description --scope global`, Issue #22 AC #3).
      // We refuse rather than silently consume, because the silently-consumed form produces
      // a confusing downstream error (`invalid --scope`) instead of pointing at the typo.
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${rawName} requires a value`);
      }
      flags[rawName] = next;
      i++;
    } else if (booleanFlags.has(rawName)) {
      if (eqIdx !== -1) {
        flags[rawName] = parseBooleanLiteral(arg.slice(eqIdx + 1), rawName);
      } else {
        flags[rawName] = true;
      }
    } else {
      throw new UsageError(`unknown option: --${rawName}`);
    }
  }

  return { positionals, flags };
}

function parseBooleanLiteral(raw: string, flagName: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
  if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  throw new UsageError(`invalid --${flagName}: ${raw} (expected true or false)`);
}

export function parseScope(raw: string | boolean | undefined): Scope | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'project' && raw !== 'global') {
    throw new UsageError(`invalid --scope: ${String(raw)} (expected project or global)`);
  }
  return raw;
}

export function parseScopeOrAll(raw: string | boolean | undefined): Scope | 'all' | undefined {
  if (raw === 'all') return 'all';
  return parseScope(raw);
}

export function parseUsage(raw: string | boolean | undefined): 'interactive' | 'unattended' | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'interactive' && raw !== 'unattended') {
    throw new UsageError(`invalid --usage: ${String(raw)} (expected interactive or unattended)`);
  }
  return raw;
}
