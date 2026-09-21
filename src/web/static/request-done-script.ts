// Served verbatim at GET /static/request-done.js. Authored as a plain
// exported string (not a real .js asset file), matching reveal-script.ts's
// rationale: the project's esbuild loader map only text-loads `.html`, and a
// blanket `.js` text loader would break every other relative import in the
// bundle. This is JS source text, not HTML, so it does not fall under the
// "no HTML built by string concatenation in .ts" rule.
//
// Auto-closes the request-done tab ~5 seconds after a successful render
// (Issue #61 AC), same-origin and external so CSP's `script-src 'self'`
// never needs `'unsafe-inline'`. `window.close()` is best-effort: browsers
// only honor it for a tab the page itself opened (e.g. via `window.open`,
// which is how this flow is typically reached from a QR scan or a fresh
// tab) and silently no-op otherwise, so a tab that can't be closed simply
// stays open with its "stored" result still visible — never an error.
export const REQUEST_DONE_CLIENT_JS = `(() => {
  setTimeout(() => {
    window.close();
  }, 5000);
})();
`;
