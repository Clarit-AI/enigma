import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs, UsageError } from '../args.js';
import { EnigmaError } from '../../core/errors.js';
import { findProjectPath } from '../../core/project.js';
import { renderOutcome } from '../../mcp/result-text.js';
import type { RequestNameResult } from '../../request/store.js';
import { RequestStore } from '../../request/store.js';
import { parseDotEnv } from '../../storage/dotenv-file.js';
import type { ParsedDotEnvEntry } from '../../storage/dotenv-file.js';
import { commitImport } from '../../storage/import-commit.js';
import type { ImportCommitFailure } from '../../storage/import-commit.js';
import type { DepositoryId } from '../../storage/interfaces.js';
import { startServer } from '../../web/server.js';

const USAGE = 'enigma import [PATH] [--depository ID] [--json]';

interface ImportReport {
  imported: string[];
  failed: ImportCommitFailure[];
  notAttempted: string[];
  skippedInvalid: string[];
  skippedMismatch: string[];
  warnings: string[];
  fileRewritten: boolean;
  depository?: DepositoryId;
}

function report(data: ImportReport, json: boolean, cwd: string, note?: string): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  } else {
    const lines: string[] = [];
    if (note) lines.push(note);
    if (data.imported.length > 0 || data.failed.length > 0) {
      const results: RequestNameResult[] = [
        ...data.failed.map((f): RequestNameResult => ({ name: f.name, ok: false, errorCode: f.errorCode })),
        ...data.imported.map((name): RequestNameResult => ({ name, ok: true })),
      ];
      lines.push(renderOutcome(results, cwd).text);
    }
    for (const f of data.failed) if (f.message) lines.push(`${f.name}: ${f.message}`);
    for (const name of data.notAttempted) lines.push(`${name}: not attempted (aborted after an earlier failure)`);
    for (const name of data.skippedInvalid) lines.push(`${name}: skipped (invalid secret name)`);
    for (const name of data.skippedMismatch) lines.push(`${name}: migrated, but its .env line was left in place (see warnings)`);
    for (const warning of data.warnings) lines.push(`warning: ${warning}`);
    if (data.failed.length > 0 && !data.fileRewritten) {
      lines.push('.env was left untouched because not every key succeeded.');
    }
    process.stdout.write(`${lines.filter((l) => l.length > 0).join('\n')}\n`);
  }
  return data.failed.length > 0 ? 1 : 0;
}

async function runBrowserFlow(
  entries: ParsedDotEnvEntry[],
  opts: { cwd: string; absPath: string; json: boolean; skippedInvalid: string[] },
): Promise<number> {
  const handle = await startServer();
  const record = RequestStore.create({
    kind: 'import',
    names: entries.map((e) => e.name),
    values: Object.fromEntries(entries.map((e) => [e.name, e.value])),
    ambiguousNames: entries.filter((e) => e.ambiguous).map((e) => e.name),
    scope: 'project',
    envFilePath: opts.absPath,
  });
  const url = `${handle.origin}/i/${record.id}`;
  process.stderr.write(
    `Open ${url} to choose where to store ${entries.length} secret(s): ${entries.map((e) => e.name).join(', ')}\n`,
  );

  try {
    await RequestStore.waitForFulfilled(record.id);
  } catch {
    return report(
      {
        imported: [],
        failed: [],
        notAttempted: entries.map((e) => e.name),
        skippedInvalid: opts.skippedInvalid,
        skippedMismatch: [],
        warnings: [],
        fileRewritten: false,
      },
      opts.json,
      opts.cwd,
      'Import link expired before it was completed.',
    );
  }

  const finalRecord = RequestStore.get(record.id);
  const results = finalRecord?.results ?? [];
  const outcome = finalRecord?.importOutcome;

  return report(
    {
      imported: results.filter((r) => r.ok).map((r) => r.name),
      failed: results
        .filter((r) => !r.ok && r.errorCode !== 'E_NOT_ATTEMPTED')
        .map((r) => ({ name: r.name, errorCode: r.errorCode ?? 'E_UNKNOWN' })),
      notAttempted: results.filter((r) => r.errorCode === 'E_NOT_ATTEMPTED').map((r) => r.name),
      skippedInvalid: opts.skippedInvalid,
      skippedMismatch: outcome?.skippedMismatch ?? [],
      warnings: outcome?.warnings ?? [],
      fileRewritten: outcome?.fileRewritten ?? false,
      depository: outcome?.depository,
    },
    opts.json,
    opts.cwd,
  );
}

export async function cmdImport(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { value: ['depository'], boolean: ['json'] });
  const pathArg = positionals[0] ?? '.env';
  const depository = flags.depository as DepositoryId | undefined;
  const json = Boolean(flags.json);

  if (positionals.length > 1) throw new UsageError(USAGE);

  const cwd = process.cwd();
  const projectPath = findProjectPath(cwd);
  const absPath = isAbsolute(pathArg) ? pathArg : join(cwd, pathArg);

  if (!existsSync(absPath)) {
    throw new EnigmaError({ code: 'E_NOT_FOUND', message: `${pathArg} not found` });
  }

  const content = readFileSync(absPath, 'utf8');
  const parsed = parseDotEnv(content);

  if (parsed.entries.length === 0) {
    return report(
      {
        imported: [],
        failed: [],
        notAttempted: [],
        skippedInvalid: parsed.invalidNames,
        skippedMismatch: [],
        warnings: [],
        fileRewritten: false,
      },
      json,
      cwd,
      'No importable secrets found.',
    );
  }

  if (!depository) {
    return runBrowserFlow(parsed.entries, { cwd, absPath, json, skippedInvalid: parsed.invalidNames });
  }

  const result = await commitImport({
    entries: parsed.entries,
    depository,
    scope: 'project',
    cwd,
    projectPath,
    envFilePath: absPath,
    actor: 'cli',
  });

  return report(
    {
      imported: result.succeeded,
      failed: result.failed,
      notAttempted: result.notAttempted,
      skippedInvalid: parsed.invalidNames,
      skippedMismatch: result.skippedMismatch,
      warnings: result.warnings,
      fileRewritten: result.fileRewritten,
      depository,
    },
    json,
    cwd,
  );
}
