import type { ServerResponse } from 'node:http';
import { errorHtml } from './templates/loaded.js';
import { renderTemplate } from './templates/render.js';

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function sendStaticJs(res: ServerResponse, content: string): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.end(content);
}

/** Renders the shared error template — used for 400/404/410/413/500. Never carries a value. */
export function sendErrorPage(res: ServerResponse, status: number, statusText: string, message: string): void {
  sendHtml(res, status, renderTemplate(errorHtml, { STATUS: statusText, MESSAGE: message }));
}
