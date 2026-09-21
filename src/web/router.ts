import type { IncomingMessage, ServerResponse } from 'node:http';
import { applySecurityHeaders } from './headers.js';
import { sendJson, sendStaticJs, sendErrorPage } from './responses.js';
import { handleImportFormGet, handleImportFormPost } from './routes/import-form.js';
import { handleRequestFormGet, handleRequestFormPost } from './routes/request-form.js';
import { handleRevealGet, handleRevealPost } from './routes/reveal.js';
import { REVEAL_CLIENT_JS } from './static/reveal-script.js';
import { REQUEST_DONE_CLIENT_JS } from './static/request-done-script.js';

const ID = '[0-9a-f]{32}';
const REQUEST_PATH = new RegExp(`^/r/(${ID})$`);
const IMPORT_PATH = new RegExp(`^/i/(${ID})$`);
const REVEAL_SHELL_PATH = new RegExp(`^/v/(${ID})$`);
const REVEAL_ACTION_PATH = new RegExp(`^/v/(${ID})/reveal$`);

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  applySecurityHeaders(res);

  const method = req.method ?? 'GET';
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://internal').pathname;
  } catch {
    sendErrorPage(res, 400, 'Bad request', 'Malformed URL.');
    return;
  }

  try {
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && pathname === '/static/reveal.js') {
      sendStaticJs(res, REVEAL_CLIENT_JS);
      return;
    }
    if (method === 'GET' && pathname === '/static/request-done.js') {
      sendStaticJs(res, REQUEST_DONE_CLIENT_JS);
      return;
    }

    const requestMatch = pathname.match(REQUEST_PATH);
    if (requestMatch) {
      const id = requestMatch[1]!;
      if (method === 'GET') return await handleRequestFormGet(res, id);
      if (method === 'POST') return await handleRequestFormPost(req, res, id);
    }

    const importMatch = pathname.match(IMPORT_PATH);
    if (importMatch) {
      const id = importMatch[1]!;
      if (method === 'GET') return await handleImportFormGet(res, id);
      if (method === 'POST') return await handleImportFormPost(req, res, id);
    }

    const revealShellMatch = pathname.match(REVEAL_SHELL_PATH);
    if (revealShellMatch && method === 'GET') {
      return handleRevealGet(res, revealShellMatch[1]!);
    }

    const revealActionMatch = pathname.match(REVEAL_ACTION_PATH);
    if (revealActionMatch && method === 'POST') {
      return await handleRevealPost(res, revealActionMatch[1]!);
    }

    sendErrorPage(res, 404, 'Not found', 'Nothing lives at this address.');
  } catch {
    sendErrorPage(res, 500, 'Internal error', 'Something went wrong.');
  }
}
