import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from '../../core/config.js';
import { findProjectPath } from '../../core/project.js';
import type { Scope } from '../../core/index-store.js';
import { RequestStore } from '../../request/store.js';
import type { RequestNameResult, RequestRecord } from '../../request/store.js';
import { checkEnvGitignore } from '../../storage/depositories/env.js';
import { commitImport } from '../../storage/import-commit.js';
import { detectAll } from '../../storage/detect.js';
import type { DepositoryId } from '../../storage/interfaces.js';
import { readBody, parseSubmission, PayloadTooLargeError } from '../body.js';
import { buildDepositoryOptions, needsAvailabilityConfirmation } from '../depository-picker.js';
import { sendErrorPage, sendHtml } from '../responses.js';
import { importFormHtml, requestDoneHtml } from '../templates/loaded.js';
import { renderRepeatingBlock, renderTemplate } from '../templates/render.js';

interface RenderFormOptions {
  status?: number;
  errorMessage?: string;
  confirmDepository?: DepositoryId;
  selectedDepositoryId?: DepositoryId;
}

async function renderForm(res: ServerResponse, record: RequestRecord, opts: RenderFormOptions = {}): Promise<void> {
  const detections = await detectAll();
  const config = loadConfig();
  const requested = opts.selectedDepositoryId ?? record.depository;

  const options = buildDepositoryOptions(detections, { sticky: config.defaultDepository, requested });
  const warnings = checkEnvGitignore(findProjectPath(process.cwd()));

  let html = importFormHtml;
  html = renderTemplate(html, { ID: record.id, COUNT: String(record.names.length) });
  html = renderRepeatingBlock(html, 'NAME_ROW', record.names.map((name) => ({ NAME: name })));
  html = renderRepeatingBlock(
    html,
    'DEP_OPTION',
    options.map((o) => ({ DEP_ID: o.id, DEP_LABEL: o.label, DEP_SELECTED: o.selected ? 'selected' : '' })),
  );
  html = renderRepeatingBlock(html, 'ERROR_BLOCK', opts.errorMessage ? [{ ERROR_MESSAGE: opts.errorMessage }] : []);
  html = renderRepeatingBlock(html, 'WARN_BLOCK', warnings.map((w) => ({ WARN_MESSAGE: w })));
  const confirmRows = opts.confirmDepository ? [{ CONFIRM_DEPOSITORY: opts.confirmDepository }] : [];
  html = renderRepeatingBlock(html, 'CONFIRM_BLOCK', confirmRows);
  html = renderRepeatingBlock(html, 'CONFIRM_CHECKBOX', confirmRows);

  sendHtml(res, opts.status ?? 200, html);
}

function getUsableImportRecord(id: string): RequestRecord | 'not-found' | 'used' {
  const record = RequestStore.get(id);
  if (!record || record.kind !== 'import') return 'not-found';
  if (record.usedAt !== undefined) return 'used';
  return record;
}

export async function handleImportFormGet(res: ServerResponse, id: string): Promise<void> {
  const record = getUsableImportRecord(id);
  if (record === 'not-found') {
    sendErrorPage(res, 404, 'Not found', 'This link is unknown or has expired.');
    return;
  }
  if (record === 'used') {
    sendErrorPage(res, 410, 'Already used', 'This link has already been used.');
    return;
  }
  await renderForm(res, record);
}

export async function handleImportFormPost(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const record = getUsableImportRecord(id);
  if (record === 'not-found') {
    sendErrorPage(res, 404, 'Not found', 'This link is unknown or has expired.');
    return;
  }
  if (record === 'used') {
    sendErrorPage(res, 410, 'Already used', 'This link has already been used.');
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendErrorPage(res, 413, 'Payload too large', 'The submission is too large.');
      return;
    }
    sendErrorPage(res, 400, 'Bad request', 'Could not read the submission.');
    return;
  }

  let submission;
  try {
    // No text values are ever submitted for an import — they're already known server-side (record.values).
    submission = parseSubmission(req.headers['content-type'], body, []);
  } catch {
    sendErrorPage(res, 400, 'Bad request', 'Could not parse the submission.');
    return;
  }

  const chosenDepository = submission.depository as DepositoryId | undefined;
  if (!chosenDepository) {
    await renderForm(res, record, { errorMessage: 'Choose a depository.' });
    return;
  }

  const detections = await detectAll();
  if (needsAvailabilityConfirmation(detections, chosenDepository) && !submission.confirmCreateVault) {
    // Pre-flight only: nothing has been written and the id is not yet consumed.
    await renderForm(res, record, { confirmDepository: chosenDepository, selectedDepositoryId: chosenDepository });
    return;
  }

  // Security boundary (S2.1, mirrors request-form.ts): the id is consumed here, before any write.
  const marked = RequestStore.tryMarkUsed(id);
  if (!marked) {
    sendErrorPage(res, 410, 'Already used', 'This link has already been used.');
    return;
  }

  const cwd = process.cwd();
  const projectPath = findProjectPath(cwd);
  const scope: Scope = record.scope ?? 'project';
  const values = record.values ?? {};
  const ambiguousNames = new Set(record.ambiguousNames ?? []);
  const ambiguousReasons = record.ambiguousReasons ?? {};
  const entries = record.names.map((name) => ({
    name,
    value: values[name] ?? '',
    ambiguous: ambiguousNames.has(name),
    ambiguousReason: ambiguousReasons[name],
  }));

  // The id is already consumed above (tryMarkUsed) — from here on, fulfill() MUST run no
  // matter what, or the CLI/MCP caller blocked in RequestStore.waitForFulfilled() hangs
  // forever with no timeout to fall back on (Issue #13 review, round 5). commitImport
  // re-parses the file from disk on its success path, so a .env deleted or made unreadable
  // between the form render and this submit throws straight out of the await — mirrors
  // request-form.ts's per-name try/catch, adapted to commitImport's single-batch call.
  let commitResult;
  try {
    commitResult = await commitImport({
      entries,
      depository: chosenDepository,
      scope,
      cwd,
      projectPath,
      envFilePath: record.envFilePath ?? `${projectPath}/.env`,
      actor: 'user',
      rotate: submission.rotate,
      createVault: submission.confirmCreateVault,
    });
  } catch {
    // Unknown per-name outcome: commitImport crashed after its own internal setSecret loop
    // (which never throws — see its own try/catch), so every name that reached this point
    // already has SOME chance of being genuinely stored. `ok: false` here means "not
    // confirmed stored", not "confirmed failed" — those are different claims. Using the
    // thrown error's own code (e.g. an fs error code) would read to any caller
    // (renderOutcome, the MCP result, --json) as "this is why the write failed", which we
    // do not know. E_OUTCOME_UNKNOWN says exactly what we can actually confirm: nothing.
    const results: RequestNameResult[] = record.names.map((name) => ({ name, ok: false, errorCode: 'E_OUTCOME_UNKNOWN' }));
    record.importOutcome = { fileRewritten: false, warnings: [], skippedMismatch: [], depository: chosenDepository };
    RequestStore.fulfill(id, results);
    sendErrorPage(
      res,
      500,
      'Import failed',
      'Something went wrong while completing the import. Some secrets may already be stored — run `enigma list` or `enigma doctor` to check before retrying.',
    );
    return;
  }

  const results: RequestNameResult[] = [
    // reason is populated ONLY for the ambiguity refusal — static structural text computed
    // by the parser before any value is looked at (see RequestNameResult's doc comment).
    // Never widen this to other error codes, whose messages aren't guaranteed value-free.
    ...commitResult.failed.map(
      (f): RequestNameResult => ({
        name: f.name,
        ok: false,
        errorCode: f.errorCode,
        reason: f.errorCode === 'E_VALUE_AMBIGUOUS' ? f.message : undefined,
      }),
    ),
    ...commitResult.notAttempted.map((name): RequestNameResult => ({ name, ok: false, errorCode: 'E_NOT_ATTEMPTED' })),
    ...commitResult.succeeded.map((name): RequestNameResult => ({ name, ok: true })),
  ];

  record.importOutcome = {
    fileRewritten: commitResult.fileRewritten,
    warnings: commitResult.warnings,
    skippedMismatch: commitResult.skippedMismatch,
    depository: chosenDepository,
  };
  RequestStore.fulfill(id, results);

  let html = requestDoneHtml;
  html = renderRepeatingBlock(
    html,
    'RESULT_ROW',
    results.map((r) => ({
      NAME: r.name,
      STATUS_CLASS: r.ok ? 'ok' : 'fail',
      STATUS_TEXT: r.ok ? 'stored' : r.reason ? `failed (${r.errorCode}): ${r.reason}` : `failed (${r.errorCode})`,
    })),
  );
  sendHtml(res, 200, html);
}
