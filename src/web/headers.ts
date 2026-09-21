import type { ServerResponse } from 'node:http';

/**
 * Applied to every response on every route, including /static/* and /healthz
 * (ADR-005, docs/api-contracts.md §2).
 *
 * `style-src 'self' 'unsafe-inline'` (Issue #61): CSP falls `style-src` back
 * to `default-src` when absent, and `'self'` alone does not permit an inline
 * `<style>` block (only same-origin external stylesheet files) — it needs
 * `'unsafe-inline'` or a nonce/hash. Every template under
 * src/web/templates/*.html carries its own `<style>` block (the dark-mode
 * media query, the `.card` design, sizing) with no build step to hash or
 * nonce it, so the browser was silently discarding all of it. Verified by
 * grep across every template: none of the `{{TOKEN}}`/`<!--BLOCK:...-->`
 * placeholders renderTemplate substitutes ever appear inside a `<style>`
 * block — user-controlled text (NAME/REASON/DESCRIPTION/…) only ever renders
 * into body content, always through renderTemplate's escapeHtml — so
 * `'unsafe-inline'` here relaxes nothing that was ever a value-injection
 * boundary. `script-src` stays locked to `'self'`: no template has an inline
 * `<script>` (enforced by test/unit/web/templates.test.ts), every script is
 * loaded from a same-origin `/static/*.js` file instead.
 */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}
