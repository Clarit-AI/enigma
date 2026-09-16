import type { ServerResponse } from 'node:http';

/** Applied to every response on every route, including /static/* and /healthz (ADR-005, docs/api-contracts.md §2). */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}
