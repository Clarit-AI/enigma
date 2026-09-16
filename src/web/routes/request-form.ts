import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestStore } from '../../request/store.js';
import type { RequestRecord, RequestNameResult } from '../../request/store.js';
import { detectAll } from '../../storage/detect.js';
import { loadConfig } from '../../core/config.js';
import { setSecret, listSecrets } from '../../storage/manager.js';
import { EnigmaError } from '../../core/errors.js';
import type { DepositoryId } from '../../storage/interfaces.js';
import type { Scope } from '../../core/index-store.js';
import { getActiveRemoteUrl } from '../../remote/index.js';
import { renderQrSvg } from '../../remote/qr.js';
import { readBody, parseSubmission, PayloadTooLargeError } from '../body.js';
import { renderRepeatingBlock, renderTemplate } from '../templates/render.js';
import { requestFormHtml, requestDoneHtml } from '../templates/loaded.js';
import { sendHtml, sendErrorPage } from '../responses.js';
import { buildDepositoryOptions, needsAvailabilityConfirmation } from '../depository-picker.js';

interface RenderFormOptions {
  status?: number;
  errorMessage?: string;
  confirmDepository?: DepositoryId;
  selectedDepositoryId?: DepositoryId;
  selectedScope?: Scope;
  rotateChecked?: boolean;
}

const QR_BLOCK_START = '<!--BLOCK:QR_BLOCK-->';
const QR_BLOCK_END = '<!--/BLOCK:QR_BLOCK-->';
const RAW_QR_SVG_TOKEN = '{{RAW_QR_SVG}}';

/**
 * Keeps or drops the whole `QR_BLOCK` section (the card, its caption, and
 * the QR itself) depending on whether a tunnel is up for this request, and
 * fills its `{{RAW_QR_SVG}}` token with the actual `<svg>` markup (Issue #12
 * AC4). Deliberately does not go through renderRepeatingBlock/renderTemplate
 * (templates/render.ts): those always HTML-escape a substitution, which is
 * exactly wrong here — renderQrSvg's output is markup to render, not text to
 * display, and escaping it would print the SVG source instead of drawing it.
 */
function insertQrBlock(html: string, activeRemoteUrl: string | undefined, requestId: string): string {
  const start = html.indexOf(QR_BLOCK_START);
  const end = html.indexOf(QR_BLOCK_END);
  if (start === -1 || end === -1) return html;

  if (!activeRemoteUrl) {
    return html.slice(0, start) + html.slice(end + QR_BLOCK_END.length);
  }

  const blockContent = html.slice(start + QR_BLOCK_START.length, end);
  const svg = renderQrSvg(`${activeRemoteUrl}/r/${requestId}`);
  const filled = blockContent.replace(RAW_QR_SVG_TOKEN, () => svg);
  return html.slice(0, start) + filled + html.slice(end + QR_BLOCK_END.length);
}

async function renderForm(res: ServerResponse, record: RequestRecord, opts: RenderFormOptions = {}): Promise<void> {
  const detections = await detectAll();
  const config = loadConfig();
  const scope: Scope = opts.selectedScope ?? record.scope ?? 'project';
  const requested = opts.selectedDepositoryId ?? record.depository;

  const options = buildDepositoryOptions(detections, {
    usage: record.usage,
    sticky: config.defaultDepository,
    requested,
  });

  const entries = listSecrets({ scope: 'all', cwd: process.cwd() });
  const nameRows = record.names.map((name) => {
    const existing = entries.find((e) => e.name === name && e.scope === scope) ?? entries.find((e) => e.name === name);
    return {
      NAME: name,
      DESCRIPTION: existing?.description ?? '',
      USAGE: record.usage ?? 'interactive',
      ROTATE_NOTE: existing ? `${name} already exists and will be rotated.` : '',
    };
  });

  let html = requestFormHtml;
  html = renderTemplate(html, {
    ID: record.id,
    REASON: record.reason ?? '',
    SCOPE_PROJECT_SELECTED: scope === 'project' ? 'selected' : '',
    SCOPE_GLOBAL_SELECTED: scope === 'global' ? 'selected' : '',
    ROTATE_CHECKED: (opts.rotateChecked ?? record.rotate) ? 'checked' : '',
  });
  html = renderRepeatingBlock(html, 'NAME_ROW', nameRows);
  html = renderRepeatingBlock(
    html,
    'DEP_OPTION',
    options.map((o) => ({ DEP_ID: o.id, DEP_LABEL: o.label, DEP_SELECTED: o.selected ? 'selected' : '' })),
  );
  html = renderRepeatingBlock(html, 'ERROR_BLOCK', opts.errorMessage ? [{ ERROR_MESSAGE: opts.errorMessage }] : []);
  const confirmRows = opts.confirmDepository ? [{ CONFIRM_DEPOSITORY: opts.confirmDepository }] : [];
  html = renderRepeatingBlock(html, 'CONFIRM_BLOCK', confirmRows);
  html = renderRepeatingBlock(html, 'CONFIRM_CHECKBOX', confirmRows);

  html = insertQrBlock(html, getActiveRemoteUrl(record.id), record.id);

  sendHtml(res, opts.status ?? 200, html);
}

export async function handleRequestFormGet(res: ServerResponse, id: string): Promise<void> {
  const record = RequestStore.get(id);
  if (!record || record.kind !== 'request') {
    sendErrorPage(res, 404, 'Not found', 'This link is unknown or has expired.');
    return;
  }
  if (record.usedAt !== undefined) {
    sendErrorPage(res, 410, 'Already used', 'This link has already been used.');
    return;
  }
  await renderForm(res, record);
}

export async function handleRequestFormPost(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const record = RequestStore.get(id);
  if (!record || record.kind !== 'request') {
    sendErrorPage(res, 404, 'Not found', 'This link is unknown or has expired.');
    return;
  }
  if (record.usedAt !== undefined) {
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
    submission = parseSubmission(req.headers['content-type'], body, record.names);
  } catch {
    sendErrorPage(res, 400, 'Bad request', 'Could not parse the submission.');
    return;
  }

  const chosenDepository = submission.depository as DepositoryId | undefined;
  const scope: Scope = (submission.scope as Scope | undefined) ?? record.scope ?? 'project';

  if (!chosenDepository) {
    await renderForm(res, record, { errorMessage: 'Choose a depository.', selectedScope: scope, rotateChecked: submission.rotate });
    return;
  }

  const detections = await detectAll();
  if (needsAvailabilityConfirmation(detections, chosenDepository) && !submission.confirmCreateVault) {
    // Pre-flight only: nothing has been written and the id is not yet
    // consumed, so the user can resubmit with confirmation.
    await renderForm(res, record, {
      confirmDepository: chosenDepository,
      selectedDepositoryId: chosenDepository,
      selectedScope: scope,
      rotateChecked: submission.rotate,
    });
    return;
  }

  // Security boundary (S2.1): the id is consumed here, before any write to
  // storage, and stays consumed even if some names below fail to write.
  const marked = RequestStore.tryMarkUsed(id);
  if (!marked) {
    sendErrorPage(res, 410, 'Already used', 'This link has already been used.');
    return;
  }

  const results: RequestNameResult[] = [];
  for (const name of record.names) {
    const value = submission.values[name];
    if (!value) {
      results.push({ name, ok: false, errorCode: 'E_MISSING_VALUE' });
      continue;
    }
    try {
      await setSecret({
        name,
        value,
        scope,
        depository: chosenDepository,
        cwd: process.cwd(),
        rotate: submission.rotate,
        actor: 'user',
        createVault: submission.confirmCreateVault,
      });
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, errorCode: err instanceof EnigmaError ? err.code : 'E_UNKNOWN' });
    }
  }

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
