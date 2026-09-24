// Shared commit logic for `enigma import` (Issue #13, D4.3), used by the CLI
// command, the MCP tool, and the web picker route so the "loud abort, no
// partial migration" contract can't drift between entry points. Lives in
// src/storage/** — an allowed location for in-flight values (style-guide).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendAuditEvent, auditErrorText, auditScopeFields } from '../core/audit.js';
import type { AuditActor } from '../core/audit.js';
import { EnigmaError } from '../core/errors.js';
import type { Scope } from '../core/index-store.js';
import { projectId as computeProjectId } from '../core/project.js';
import { checkEnvGitignore } from './depositories/env.js';
import { parseDotEnv, removeDotEnvEntries } from './dotenv-file.js';
import type { ParsedDotEnvEntry } from './dotenv-file.js';
import type { DepositoryId } from './interfaces.js';
import { setSecret } from './manager.js';

const FILE_MODE = 0o600;

interface AtomicWriteResult {
  ok: boolean;
  /** Set iff !ok: the write/rename failure, safe to surface (never a value — this is filesystem error text, not file content). */
  error?: string;
  /** Set iff !ok AND the leftover temp file (holding the FULL rewritten content — every other credential in the file, not just the migrated ones) could not be cleaned up either. Names the path so the caller can tell the user, rather than leaving a plaintext file silently sitting in the project directory. */
  leftoverPath?: string;
}

/**
 * Temp file + rename, in the same directory as `path` (so the rename is
 * atomic on the same filesystem). This rewrite touches the WHOLE file,
 * including keys that were never part of the import batch and have no
 * depository copy anywhere — unlike the `env` depository's own block-only
 * writes, a torn write here could destroy credentials this command was
 * never asked to touch (Issue #13 review, round 2, A1).
 *
 * Never throws: a write or rename failure is reported via the return value
 * so the caller can fold it into `warnings[]` rather than crash. On failure,
 * always attempts to unlink the temp file — leaving a plaintext copy of the
 * whole file sitting in the project directory is exactly what a later
 * `git add -A` sweeps up, and it must never happen silently (round 3, item 2).
 */
function writeFileAtomic(path: string, content: string, mode: number): AtomicWriteResult {
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, content, { mode });
    renameSync(tmpPath, path);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
      return { ok: false, error };
    } catch {
      return { ok: false, error, leftoverPath: tmpPath };
    }
  }
}

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
  /** Human-readable detail, set for validation-style failures (e.g. an ambiguous value) rather than a bare depository error code. */
  message?: string;
}

export interface ImportCommitResult {
  succeeded: string[];
  failed: ImportCommitFailure[];
  /** Names never attempted because an earlier name in the batch failed first (loud-abort semantics). */
  notAttempted: string[];
  /** Names that stored successfully but whose .env line was left in place because it no longer matched the migrated value by rewrite time (Issue #13 review, round 2, B1). */
  skippedMismatch: string[];
  fileRewritten: boolean;
  warnings: string[];
}

/** One code, one path, for every reason `parseDotEnv` can flag an entry `ambiguous` (inline-comment-like value, or a duplicated name) — the reason text itself comes from the parser, which is the only place with enough context to phrase it precisely. */
function ambiguousValueError(entry: ParsedDotEnvEntry, envFilePath: string): EnigmaError {
  return new EnigmaError({
    code: 'E_VALUE_AMBIGUOUS',
    message: `${entry.name} in ${envFilePath} is ambiguous: ${entry.ambiguousReason ?? 'the value or its assignment could not be resolved unambiguously'}`,
    secretName: entry.name,
  });
}

/**
 * Stores each entry via `setSecret`, stopping at the first failure (the
 * tech-lead-mandated "loud abort" — see Issue #13 design notes). An
 * unquoted value containing an ambiguous inline-comment-like " #" is refused
 * before ever reaching a depository (Issue #13 review, round 2, A2) — the
 * same abort path as a real depository failure, since guessing either way
 * (keep it, strip it) risks corrupting or truncating the secret.
 *
 * The source file is rewritten to remove the migrated raw lines ONLY when
 * every entry succeeded; on any failure it is left completely untouched, so
 * a not-yet-migrated credential can never be lost. The one unavoidable
 * exception: the `env` depository writes its own managed block as a direct
 * side effect of a successful `setSecret` call, so an entry that lands there
 * before a later failure is already in the block (flagged via `warnings`)
 * even though its original plaintext line is deliberately left in place too.
 *
 * On full success, the file is re-parsed immediately before the rewrite and
 * only lines whose CURRENT value still matches what was actually migrated
 * are removed (round 2, B1) — if the user edited the file between parse and
 * commit, the stale copy is left in place and reported in `warnings`,
 * turning what would otherwise be a silent value loss into an informative
 * refusal for that one name. The rewrite itself is temp-file-plus-rename
 * (round 2, A1): a crash mid-write must never be able to leave the file
 * truncated, since it also carries keys this batch never touched. A failed
 * rewrite is reported in `warnings` rather than thrown, and its leftover
 * temp file is cleaned up — or, if that cleanup itself fails, named in a
 * second warning rather than left as a silent plaintext copy in the project
 * directory (round 3, item 2).
 *
 * Audit-worthiness (Issue #39), decided per outcome:
 * - The ambiguous-value refusal IS audited, right here, because it's the one
 *   outcome that leaves zero trace anywhere else — `setSecret` is never
 *   called for that entry, so nothing else in the stack would ever record
 *   that this name was attempted and refused.
 * - A depository-level refusal reached via `setSecret` (E_EXISTS,
 *   E_SCOPE_INVALID, a real depository failure) is now audited by
 *   `setSecret` itself for every caller, not specially handled here — the
 *   "loud abort" case above (a later entry existing already) is covered by
 *   that fix, not by anything in this file.
 * - `notAttempted` names are NOT audited: nothing was attempted against any
 *   of them individually — no depository was chosen, no decision was made
 *   about that one name — so there is no per-name event to record; the
 *   batch-level abort is already visible via the one entry whose refusal
 *   stopped it.
 * - `skippedMismatch` names are NOT audited as a distinct event: the secret
 *   itself was already stored successfully and that write is already
 *   audited (via `setSecret`'s own `ok: true` line); leaving the stale
 *   plaintext `.env` line in place is a decision about a plaintext file, not
 *   a secret-lifecycle event, and it's already surfaced to the caller via
 *   `warnings` every time it happens.
 * - The `.gitignore` warning is NOT audited: it names no secret and no
 *   depository (`AuditEvent` requires both), fires on every import
 *   regardless of outcome, and is already shown to the user in the same
 *   `warnings` array on every run — logging it per-import would just
 *   duplicate that, not add a record of anything that could otherwise go
 *   unseen.
 */
export async function commitImport(opts: ImportCommitOptions): Promise<ImportCommitResult> {
  const succeeded: string[] = [];
  const failed: ImportCommitFailure[] = [];

  for (const entry of opts.entries) {
    try {
      if (entry.ambiguous) {
        const err = ambiguousValueError(entry, opts.envFilePath);
        // setSecret is never reached for this entry, so nothing else will audit this
        // refusal — it happened (the file was read, the value inspected, and the import
        // stopped) and left the depository untouched, which is exactly the case Issue #39
        // requires a durable record for. Names and the error code only, never the value:
        // `ambiguousReason` (folded into auditErrorText via the error message) is always
        // static, structural text from the parser, never an echo of the value itself.
        appendAuditEvent({
          op: 'import',
          name: entry.name,
          depository: opts.depository,
          actor: opts.actor,
          ok: false,
          error: auditErrorText(err),
          ...auditScopeFields({
            scope: opts.scope,
            projectId: opts.scope === 'project' ? computeProjectId(opts.cwd) : undefined,
            projectPath: opts.projectPath,
          }),
        });
        throw err;
      }
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
      failed.push({
        name: entry.name,
        errorCode: err instanceof EnigmaError ? err.code : 'E_UNKNOWN',
        message: err instanceof EnigmaError ? err.message : undefined,
      });
      break;
    }
  }

  const attempted = new Set([...succeeded, ...failed.map((f) => f.name)]);
  const notAttempted = opts.entries.map((e) => e.name).filter((name) => !attempted.has(name));
  const warnings = checkEnvGitignore(opts.projectPath);

  if (failed.length > 0) {
    // Partial durability is NOT env-specific — setSecret commits per entry with no
    // batch-level rollback, on every depository. env is merely where the duplication is
    // visible, because the value lands in the same file being imported (Issue #42). A
    // keychain/encrypted/1password import that fails partway durably stores everything
    // that came before it just as much, so every depository must say so; only the wording
    // about the plaintext copy is env-specific, since only env leaves one behind.
    if (succeeded.length > 0) {
      const names = succeeded.join(', ');
      warnings.push(
        opts.depository === 'env'
          ? `${succeeded.length} secret(s) (${names}) were already written into the .env managed block before the failure on ${failed[0]!.name}; the original plaintext line(s) were deliberately left in place. Fix the issue and rerun import with rotate enabled to overwrite them, or remove them from .env manually.`
          : `${succeeded.length} secret(s) (${names}) are already stored in ${opts.depository} before the failure on ${failed[0]!.name}; .env was left untouched. Fix the issue and rerun import with rotate enabled to overwrite them, or remove them from ${opts.depository} manually.`,
      );
    }
    return { succeeded, failed, notAttempted, skippedMismatch: [], fileRewritten: false, warnings };
  }

  const currentContent = existsSync(opts.envFilePath) ? readFileSync(opts.envFilePath, 'utf8') : '';
  const valueByName = new Map(opts.entries.map((e) => [e.name, e.value]));
  const currentValueByName = new Map(parseDotEnv(currentContent).entries.map((e) => [e.name, e.value]));

  const toRemove: string[] = [];
  const skippedMismatch: string[] = [];
  for (const name of succeeded) {
    const currentValue = currentValueByName.get(name);
    if (currentValue === undefined) continue; // already gone — nothing to remove, nothing lost
    if (currentValue === valueByName.get(name)) toRemove.push(name);
    else skippedMismatch.push(name);
  }
  for (const name of skippedMismatch) {
    warnings.push(
      `${name} was migrated, but its value in .env changed before the file could be rewritten — left in place rather than guessing which copy is current. Rerun import to migrate the new value, or remove the line manually.`,
    );
  }

  const movedComment =
    toRemove.length === 0 || opts.depository === 'env'
      ? undefined
      : `# Moved to Enigma (${opts.depository}) by \`enigma import\` on ${new Date().toISOString()}: ${toRemove.join(', ')}`;
  const rewritten = toRemove.length > 0 ? removeDotEnvEntries(currentContent, toRemove, { comment: movedComment }) : currentContent;
  const needsWrite = rewritten !== currentContent;

  if (!needsWrite) {
    return { succeeded, failed: [], notAttempted: [], skippedMismatch, fileRewritten: false, warnings };
  }

  const writeResult = writeFileAtomic(opts.envFilePath, rewritten, FILE_MODE);
  if (!writeResult.ok) {
    warnings.push(
      `Failed to rewrite ${opts.envFilePath} (${writeResult.error}). The migrated secret(s) (${toRemove.join(', ')}) are safely stored, but their plaintext line(s) were left in place because the file could not be rewritten — rerun import once the issue is fixed, or remove them from .env manually.`,
    );
    if (writeResult.leftoverPath) {
      warnings.push(
        `A temporary file containing the full rewritten .env content was left behind at ${writeResult.leftoverPath} and could not be removed automatically — delete it manually as soon as possible.`,
      );
    }
    return { succeeded, failed: [], notAttempted: [], skippedMismatch, fileRewritten: false, warnings };
  }

  return { succeeded, failed: [], notAttempted: [], skippedMismatch, fileRewritten: true, warnings };
}
