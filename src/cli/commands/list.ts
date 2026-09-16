import { parseArgs, parseScopeOrAll } from '../args.js';
import { listSecrets } from '../../storage/manager.js';
import { DEPOSITORY_MODULES } from '../../storage/detect.js';
import type { IndexEntryView } from '../../core/index-store.js';

function promptProfileFor(depository: IndexEntryView['depository']): string {
  return DEPOSITORY_MODULES.find((m) => m.id === depository)?.promptProfile ?? 'unknown';
}

export async function cmdList(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, { value: ['scope'], boolean: ['json'] });
  const scope = parseScopeOrAll(flags.scope) ?? 'all';
  const json = Boolean(flags.json);

  // Index-only read (D1.5): never resolves a value or touches a depository.
  const entries = listSecrets({ scope, cwd: process.cwd() });

  if (json) {
    process.stdout.write(`${JSON.stringify({ entries })}\n`);
    return 0;
  }

  if (entries.length === 0) {
    process.stdout.write('No secrets found.\n');
    return 0;
  }

  const rows = entries.map((e) => ({
    name: e.name,
    scope: e.scope,
    depository: e.depository,
    promptProfile: promptProfileFor(e.depository),
    usage: e.usage ?? '',
    updatedAt: e.updatedAt,
    shadowed: e.shadowed ? 'yes' : '',
  }));

  const headers = ['NAME', 'SCOPE', 'DEPOSITORY', 'PROMPT PROFILE', 'USAGE', 'UPDATED', 'SHADOWED'];
  const columns = [headers, ...rows.map((r) => [r.name, r.scope, r.depository, r.promptProfile, r.usage, r.updatedAt, r.shadowed])];
  const widths = headers.map((_, i) => Math.max(...columns.map((row) => row[i]!.length)));
  const lines = columns.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
