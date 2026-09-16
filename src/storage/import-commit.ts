// Shared commit logic for `enigma import` (Issue #13, D4.3), used by the CLI
// command, the MCP tool, and the web picker route so the "loud abort, no
// partial migration" contract can't drift between entry points. Lives in
// src/storage/** — an allowed location for in-flight values (style-guide).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AuditActor } from '../core/audit.js';
import { EnigmaError } from '../core/errors.js';
import type { Scope } from '../core/index-store.js';
import { checkEnvGitignore } from './depositories/env.js';
import { removeDotEnvEntries } from './dotenv-file.js';
import type { ParsedDotEnvEntry } from './dotenv-file.js';
import type { DepositoryId } from './interfaces.js';
import { setSecret } from './manager.js';

const FILE_MODE = 0o600;

export interface ImportCommitOptions {
  entries: ParsedDotEnvEntry[];
  depository: DepositoryId;
  scope: Scope;
  cwd: string;
  projectPath: string;
  /** The source `.env`-format file being imported FROM; rewritten only on full success. */
  envFilePath: string;
  actor: AuditActor;
  rotate?: boolean;
  createVault?: boolean;
}

export interface ImportCommitFailure {
  name: string;
  errorCode: string;
}

export interface ImportCommitResult {
  succeeded: string[];
  failed: ImportCommitFailure[];
  /** Names never attempted because an earlier name in the batch failed first (loud-abort semantics). */
  notAttempted: string[];
  fileRewritten: boolean;
  warnings: string[];
}

/**
 * Stores each entry via `setSecret`, stopping at the first failure (the
 * tech-lead-mandated "loud abort" — see Issue #13 design notes). The source
 * file is rewritten to remove the migrated raw lines ONLY when every entry
 * succeeded; on any failure it is left completely untouched, so a
 * not-yet-migrated credential can never be lost. The one unavoidable
 * exception: the `env` depository writes its own managed block as a direct
 * side effect of a successful `setSecret` call, so an entry that lands there
 * before a later failure is already in the block (flagged via `warnings`)
 * even though its original plaintext line is deliberately left in place too.
 */
export async function commitImport(opts: ImportCommitOptions): Promise<ImportCommitResult> {
  const succeeded: string[] = [];
  const failed: ImportCommitFailure[] = [];

  for (const entry of opts.entries) {
    try {
      await setSecret({
        name: entry.name,
        value: entry.value,
        scope: opts.scope,
        depository: opts.depository,
        cwd: opts.cwd,
        actor: opts.actor,
        rotate: opts.rotate,
        createVault: opts.createVault,
        auditOp: 'import',
      });
      succeeded.push(entry.name);
    } catch (err) {
      failed.push({ name: entry.name, errorCode: err instanceof EnigmaError ? err.code : 'E_UNKNOWN' });
      break;
    }
  }

  const attempted = new Set([...succeeded, ...failed.map((f) => f.name)]);
  const notAttempted = opts.entries.map((e) => e.name).filter((name) => !attempted.has(name));
  const warnings = checkEnvGitignore(opts.projectPath);

  if (failed.length > 0) {
    if (opts.depository === 'env' && succeeded.length > 0) {
      warnings.push(
        `${succeeded.length} secret(s) (${succeeded.join(', ')}) were already written into the .env managed block before the failure on ${failed[0]!.name}; the original plaintext line(s) were deliberately left in place. Fix the issue and rerun import, or remove them from .env manually.`,
      );
    }
    return { succeeded, failed, notAttempted, fileRewritten: false, warnings };
  }

  const currentContent = existsSync(opts.envFilePath) ? readFileSync(opts.envFilePath, 'utf8') : '';
  const movedComment =
    opts.depository === 'env'
      ? undefined
      : `# Moved to Enigma (${opts.depository}) by \`enigma import\` on ${new Date().toISOString()}: ${succeeded.join(', ')}`;
  const rewritten = removeDotEnvEntries(currentContent, succeeded, { comment: movedComment });
  const fileRewritten = rewritten !== currentContent;
  if (fileRewritten) writeFileSync(opts.envFilePath, rewritten, { mode: FILE_MODE });

  return { succeeded, failed: [], notAttempted: [], fileRewritten, warnings };
}
