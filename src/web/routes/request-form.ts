import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestStore, annotateSkippedNames } from '../../request/store.js';
import type { RequestRecord, RequestNameResult } from '../../request/store.js';
import { detectAll } from '../../storage/detect.js';
import { loadConfig } from '../../core/config.js';
import { setSecret, listSecrets } from '../../storage/manager.js';
import { EnigmaError } from '../../core/errors.js';
import { validateName } from '../../core/naming.js';
import { parseDotEnv } from '../../storage/dotenv-file.js';
import type { DepositoryId } from '../../storage/interfaces.js';
import type { Scope } from '../../core/index-store.js';
import { getActiveRemoteUrl } from '../../remote/index.js';
import { renderQrSvg } from '../../remote/qr.js';
import { readBody, parseSubmission, PayloadTooLargeError } from '../body.js';
import type { ParsedSubmission } from '../body.js';
import { renderRepeatingBlock, renderTemplate } from '../templates/render.js';
import { requestFormHtml, requestDoneHtml } from '../templates/loaded.js';
import { sendHtml, sendErrorPage } from '../responses.js';
import { buildDepositoryOptions, needsCreateVaultConfirmation } from '../depository-picker.js';

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

/** At most this many names (declared + human-added) per submission; beyond it the whole submission is refused before the id is consumed (Issue #71, Decision 3). */
export const MAX_TOTAL_NAMES = 25;

/**
 * Human-typed names are also capped in length. `NAME_PATTERN` has no bound,
 * and an all-caps token pasted into a name field can happen to match it — a
 * name that passes `validateName` IS echoed back (done page, outcome text),
 * so an over-long one is counted as invalid instead of ever being echoed.
 */
const MAX_EXTRA_NAME_LENGTH = 128;

/**
 * The gate every human-supplied name passes before it may become a
 * `RequestNameResult.name`, reach a response body, or appear in outcome text
 * (Issue #71 invariant). `validateName` only rejects — it does not sanitize —
 * so a name that fails here is counted and its text discarded, never echoed.
 * The thrown EnigmaError carries the rejected text, so it is swallowed here
 * and never logged or rethrown.
 */
function isValidExtraName(name: string): boolean {
  if (name.length > MAX_EXTRA_NAME_LENGTH) return false;
  try {
    validateName(name);
    return true;
  } catch {
    return false;
  }
}

interface PlannedName {
  name: string;
  value: string;
  addedByUser: boolean;
  /** Set when the name is refused outright instead of written: a duplicate, or an ambiguous blob entry. */
  refusal?: { errorCode: string; reason?: string };
}

interface SubmissionPlan {
  /** Distinct validated names in write order: declared first, then rows, then blob entries. */
  names: PlannedName[];
  /** Manual extra rows whose name failed validation — counted, text discarded. */
  skippedRows: number;
  /** Distinct blob keys that failed naming — counted, text discarded. */
  skippedBlobNames: number;
}

interface Candidate {
  name: string;
  value: string;
  addedByUser: boolean;
  ambiguous: boolean;
  ambiguousReason?: string;
}

/**
 * Validates and reconciles everything the human submitted, WITHOUT writing or
 * consuming anything — so the caller can refuse an over-cap submission while
 * the id is still usable (Issue #71, Decision 3). Reuses `parseDotEnv` for
 * the blob; there is deliberately no other parser and no echo endpoint.
 */
function planSubmission(declared: readonly string[], submission: ParsedSubmission): SubmissionPlan {
  const candidates: Candidate[] = [...new Set(declared)].map((name) => ({
    name,
    value: submission.values[name] ?? '',
    addedByUser: false,
    ambiguous: false,
  }));

  let skippedRows = 0;
  for (const row of submission.extraRows) {
    if (!isValidExtraName(row.name)) {
      skippedRows++;
      continue;
    }
    candidates.push({ name: row.name, value: row.value, addedByUser: true, ambiguous: false });
  }

  let skippedBlobNames = 0;
  if (submission.dotenvBlob) {
    const parsed = parseDotEnv(submission.dotenvBlob);
    skippedBlobNames += parsed.invalidNames.length;
    for (const entry of parsed.entries) {
      if (!isValidExtraName(entry.name)) {
        skippedBlobNames++;
        continue;
      }
      candidates.push({
        name: entry.name,
        value: entry.value,
        addedByUser: true,
        ambiguous: entry.ambiguous,
        ambiguousReason: entry.ambiguousReason,
      });
    }
  }

  const byName = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = byName.get(candidate.name);
    if (group) group.push(candidate);
    else byName.set(candidate.name, [candidate]);
  }

  const names: PlannedName[] = [];
  for (const [name, group] of byName) {
    const first = group[0]!;
    // A name seen twice across declared/rows/blob is refused outright: never guess which value wins.
    const ambiguous = group.length > 1 || first.ambiguous;
    names.push({
      name,
      value: first.value,
      // The first occurrence decides: a declared name that a row or the blob repeats stays "requested".
      addedByUser: first.addedByUser,
      refusal: ambiguous
        ? { errorCode: 'E_VALUE_AMBIGUOUS', reason: group.find((c) => c.ambiguousReason !== undefined)?.ambiguousReason }
        : undefined,
    });
  }
  return { names, skippedRows, skippedBlobNames };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
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
    // Unavailable depositories stay in the list — never hidden — but are
    // rendered `disabled` so they can't be silently selected, and their
    // label states why (Issue #61: "a control that overstates itself is
    // worse than one that states its limits"). `available`/`reason` are
    // already computed by buildDepositoryOptions; this is the first call
    // site that actually gates on them.
    options.map((o) => ({
      DEP_ID: o.id,
      DEP_LABEL: o.available ? o.label : `${o.label} — unavailable: ${o.reason ?? 'not available'}`,
      DEP_SELECTED: o.selected ? 'selected' : '',
      DEP_DISABLED: o.available ? '' : 'disabled',
    })),
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

  // Validate and reconcile before anything is consumed or written. Nothing in
  // the error below is derived from submitted text (only the cap constant), so
  // a refused submission cannot echo a name or value back.
  const plan = planSubmission(record.names, submission);
  if (plan.names.length > MAX_TOTAL_NAMES) {
    await renderForm(res, record, {
      status: 400,
      errorMessage: `Too many secrets: a request can hold at most ${MAX_TOTAL_NAMES}. Remove some and submit again.`,
      selectedDepositoryId: chosenDepository,
      selectedScope: scope,
      rotateChecked: submission.rotate,
    });
    return;
  }

  if (!chosenDepository) {
    await renderForm(res, record, { errorMessage: 'Choose a depository.', selectedScope: scope, rotateChecked: submission.rotate });
    return;
  }

  const detections = await detectAll();
  if ((await needsCreateVaultConfirmation(detections, chosenDepository)) && !submission.confirmCreateVault) {
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
  for (const planned of plan.names) {
    const { name } = planned;
    // Only ever set to `true` for a validated name the agent did not ask for.
    const marker = planned.addedByUser ? { addedByUser: true as const } : {};
    if (planned.refusal) {
      // reason: only ever ParsedDotEnvEntry.ambiguousReason from parseDotEnv (the same
      // static, value-free text import uses) for an ambiguous or duplicated blob entry —
      // undefined for a name repeated across declared/rows/blob. See
      // test/unit/reason-field-surfaces.test.ts (Issue #38) for the golden-set guard.
      results.push({
        name,
        ok: false,
        errorCode: planned.refusal.errorCode,
        reason: planned.refusal.reason,
        ...marker,
      });
      continue;
    }
    if (!planned.value) {
      results.push({ name, ok: false, errorCode: 'E_MISSING_VALUE', ...marker });
      continue;
    }
    try {
      await setSecret({
        name,
        value: planned.value,
        scope,
        depository: chosenDepository,
        cwd: process.cwd(),
        rotate: submission.rotate,
        actor: 'user',
        createVault: submission.confirmCreateVault,
      });
      results.push({ name, ok: true, ...marker });
    } catch (err) {
      // reason: only ever EnigmaError.message from this specific call site (setSecret's
      // per-name write, above) — audited across every EnigmaError this path can throw
      // (src/storage/manager.ts's setSecret + all five depositories' `set()`): every
      // message interpolates only structural text (the secret NAME, a depository id, a
      // byte limit, a ref pattern) or is a static string, never opts.value. See
      // test/unit/reason-field-surfaces.test.ts (Issue #38) for the golden-set guard that
      // fails this file's build if a future edit here ever changes what's assigned.
      results.push({
        name,
        ok: false,
        errorCode: err instanceof EnigmaError ? err.code : 'E_UNKNOWN',
        reason: err instanceof EnigmaError ? err.message : undefined,
        ...marker,
      });
    }
  }

  RequestStore.fulfill(id, annotateSkippedNames(results, plan.skippedRows + plan.skippedBlobNames));

  const rows = results.map((r) => ({
    NAME: r.addedByUser ? `${r.name} (added by you)` : r.name,
    STATUS_CLASS: r.ok ? 'ok' : 'fail',
    STATUS_TEXT: r.ok ? 'stored' : r.reason ? `failed (${r.errorCode}): ${r.reason}` : `failed (${r.errorCode})`,
  }));
  // Skipped names are reported by count only — their text is never rendered (Issue #71).
  if (plan.skippedRows > 0) {
    rows.push({
      NAME: `${plan.skippedRows} added ${plural(plan.skippedRows, 'row', 'rows')} skipped`,
      STATUS_CLASS: 'fail',
      STATUS_TEXT: 'invalid name',
    });
  }
  if (plan.skippedBlobNames > 0) {
    rows.push({
      NAME: `${plan.skippedBlobNames} invalid ${plural(plan.skippedBlobNames, 'name', 'names')} skipped`,
      STATUS_CLASS: 'fail',
      STATUS_TEXT: 'in the pasted .env blob',
    });
  }

  sendHtml(res, 200, renderRepeatingBlock(requestDoneHtml, 'RESULT_ROW', rows));
}
