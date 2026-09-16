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
  const entries = record.names.map((name) => ({ name, value: values[name] ?? '' }));

  const commitResult = await commitImport({
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

  const results: RequestNameResult[] = [
    ...commitResult.failed.map((f): RequestNameResult => ({ name: f.name, ok: false, errorCode: f.errorCode })),
    ...commitResult.notAttempted.map((name): RequestNameResult => ({ name, ok: false, errorCode: 'E_NOT_ATTEMPTED' })),
    ...commitResult.succeeded.map((name): RequestNameResult => ({ name, ok: true })),
  ];

  record.importOutcome = { fileRewritten: commitResult.fileRewritten, warnings: commitResult.warnings, depository: chosenDepository };
  RequestStore.fulfill(id, results);

  let html = requestDoneHtml;
  html = renderRepeatingBlock(
    html,
    'RESULT_ROW',
    results.map((r) => ({
      NAME: r.name,
      STATUS_CLASS: r.ok ? 'ok' : 'fail',
      STATUS_TEXT: r.ok ? 'stored' : `failed (${r.errorCode})`,
    })),
  );
  sendHtml(res, 200, html);
}
