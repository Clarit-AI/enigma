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
  /** Flags that are present/absent only: `--flag`. */
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
      if (next === undefined) throw new UsageError(`--${rawName} requires a value`);
      flags[rawName] = next;
      i++;
    } else if (booleanFlags.has(rawName)) {
      flags[rawName] = true;
    } else {
      throw new UsageError(`unknown option: --${rawName}`);
    }
  }

  return { positionals, flags };
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
