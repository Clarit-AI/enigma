import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EnigmaError } from '../../core/errors.js';
import { findProjectPath } from '../../core/project.js';
import { RequestStore } from '../../request/store.js';
import type { RequestNameResult } from '../../request/store.js';
import { parseDotEnv } from '../../storage/dotenv-file.js';
import { commitImport } from '../../storage/import-commit.js';
import { startServer } from '../../web/server.js';
import { elicitUrl, sendElicitationComplete, supportsUrlElicitation } from '../elicit.js';
import { resolveRequestOutcome } from '../request-outcome.js';
import { errorResult, renderOutcome, textResult } from '../result-text.js';
import { DEPOSITORY_ID_SCHEMA } from '../schemas.js';

function renderImportSummary(
  result: { succeeded: string[]; failed: Array<{ name: string; errorCode: string }>; notAttempted: string[]; warnings: string[] },
  invalidNames: string[],
  cwd: string,
): { text: string; isError: boolean } {
  const results: RequestNameResult[] = [
    ...result.failed.map((f): RequestNameResult => ({ name: f.name, ok: false, errorCode: f.errorCode })),
    ...result.succeeded.map((name): RequestNameResult => ({ name, ok: true })),
  ];
  const outcome = renderOutcome(results, cwd);
  const extraLines = [
    ...result.notAttempted.map((name) => `${name}: not attempted (aborted after an earlier failure)`),
    ...invalidNames.map((name) => `${name}: skipped (invalid secret name)`),
    ...result.warnings.map((w) => `warning: ${w}`),
  ];
  const text = [outcome.text, ...extraLines].filter((l) => l.length > 0).join('\n');
  return { text, isError: outcome.isError };
}

export function registerImportTool(server: McpServer): void {
  server.registerTool(
    'enigma_import',
    {
      title: 'Import secrets from a .env file',
      description:
        'Imports NAME=value pairs from a .env file into a depository — either the one given, or a browser picker when none is given — removing them from plaintext (or moving them into the managed block for the env depository). Returns names, counts, and depository ids only, never a value (ADR-001).',
      inputSchema: {
        path: z.string().optional(),
        depository: DEPOSITORY_ID_SCHEMA.optional(),
      },
    },
    async (args) => {
      const cwd = process.cwd();
      const projectPath = findProjectPath(cwd);
      const pathArg = args.path ?? '.env';
      const absPath = isAbsolute(pathArg) ? pathArg : join(cwd, pathArg);

      if (!existsSync(absPath)) {
        return errorResult(new EnigmaError({ code: 'E_NOT_FOUND', message: `${pathArg} not found` }));
      }

      const content = readFileSync(absPath, 'utf8');
      const parsed = parseDotEnv(content);

      if (parsed.entries.length === 0) {
        return textResult(
          parsed.invalidNames.length > 0
            ? `No importable secrets found (${parsed.invalidNames.length} name(s) skipped: invalid format)`
            : 'No importable secrets found',
        );
      }

      if (args.depository) {
        const result = await commitImport({
          entries: parsed.entries,
          depository: args.depository,
          scope: 'project',
          cwd,
          projectPath,
          envFilePath: absPath,
          actor: 'agent',
        });
        const summary = renderImportSummary(result, parsed.invalidNames, cwd);
        return textResult(summary.text, summary.isError);
      }

      const handle = await startServer();
      const record = RequestStore.create({
        kind: 'import',
        names: parsed.entries.map((e) => e.name),
        values: Object.fromEntries(parsed.entries.map((e) => [e.name, e.value])),
        scope: 'project',
        envFilePath: absPath,
      });
      const url = `${handle.origin}/i/${record.id}`;

      if (!supportsUrlElicitation(server.server)) {
        const fallback = { request_id: record.id, url, expiresAt: new Date(record.expiresAt).toISOString() };
        return textResult(
          `${JSON.stringify(fallback)}\nClient does not support URL-mode elicitation. Call enigma_await with this request_id once the user has chosen a depository.`,
        );
      }

      const names = parsed.entries.map((e) => e.name);
      const result = await elicitUrl(server.server, {
        elicitationId: record.id,
        url,
        message: `Choose where to store ${names.length} secret(s) imported from ${pathArg}: ${names.join(', ')}`,
      });

      if (result.action !== 'accept') {
        return textResult(`Import cancelled for ${names.join(', ')}`, true);
      }

      const outcome = await resolveRequestOutcome(record.id, cwd);
      await sendElicitationComplete(server.server, record.id);
      return textResult(outcome.text, outcome.isError);
    },
  );
}
