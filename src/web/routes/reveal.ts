// enigma:leak-fence-allow: the one route that legitimately resolves a value (ADR-001) — POST /v/:id/reveal
import type { ServerResponse } from 'node:http';
import { RequestStore } from '../../request/store.js';
import { resolveSecret } from '../../storage/manager.js';
import { EnigmaError } from '../../core/errors.js';
import { renderTemplate } from '../templates/render.js';
import { revealShellHtml } from '../templates/loaded.js';
import { sendHtml, sendJson, sendErrorPage } from '../responses.js';

export function handleRevealGet(res: ServerResponse, id: string): void {
  const record = RequestStore.get(id);
  if (!record || record.kind !== 'reveal') {
    sendErrorPage(res, 404, 'Not found', 'This link is unknown or has expired.');
    return;
  }
  if (record.usedAt !== undefined) {
    sendErrorPage(res, 410, 'Already used', 'This link has already been used.');
    return;
  }

  const [name] = record.names;
  const html = renderTemplate(revealShellHtml, { ID: record.id, NAME: name ?? '' });
  sendHtml(res, 200, html);
}

export async function handleRevealPost(res: ServerResponse, id: string): Promise<void> {
  const record = RequestStore.get(id);
  if (!record || record.kind !== 'reveal') {
    sendErrorPage(res, 404, 'Not found', 'This link is unknown or has expired.');
    return;
  }

  // Security boundary (S2.2): consumed before the value is ever resolved, so
  // a concurrent duplicate POST can never see it twice.
  const marked = RequestStore.tryMarkUsed(id);
  if (!marked) {
    sendErrorPage(res, 410, 'Already used', 'This link has already been used.');
    return;
  }
  // A reveal has no per-name write outcome to report, but "fulfilled" means
  // only that a human completed the interaction (Issue #10) — true the
  // moment the token above is consumed, regardless of whether the resolve
  // below succeeds.
  RequestStore.fulfill(id);

  const [name] = marked.names;
  if (!name) {
    sendErrorPage(res, 404, 'Not found', 'This link is unknown or has expired.');
    return;
  }

  try {
    const value = await resolveSecret(name, { scope: marked.scope, cwd: process.cwd(), actor: 'user', auditOp: 'reveal', auditMethod: 'page' });
    sendJson(res, 200, { name, value });
  } catch (err) {
    if (err instanceof EnigmaError && err.code === 'E_NOT_FOUND') {
      sendErrorPage(res, 404, 'Not found', 'This secret no longer exists.');
      return;
    }
    sendErrorPage(res, 500, 'Internal error', 'Could not reveal this secret.');
  }
}
