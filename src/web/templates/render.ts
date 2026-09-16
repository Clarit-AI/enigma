// Minimal token/block substitution over already-loaded .html text (loaded via
// `?raw` imports elsewhere). Every tag here originates in a .html file under
// src/web/templates/ — this module only ever slices and joins existing text,
// never authors new markup (style-guide: "no HTML built by string concatenation
// in .ts").
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Replaces every `{{TOKEN}}` with its escaped value from `vars`; a token with no matching key is left as-is. */
export function renderTemplate(html: string, vars: Record<string, string>): string {
  return html.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(vars, token) ? escapeHtml(vars[token]!) : match,
  );
}

/**
 * Extracts the block between `<!--BLOCK:name-->` and `<!--/BLOCK:name-->`
 * markers already present in `html`, renders it once per row via
 * `renderTemplate`, and replaces the whole marked region (markers included)
 * with the joined result. An empty `rows` array removes the section
 * entirely — the same mechanism doubles as an if-block for optional UI
 * (a rotate warning, a vault-missing confirmation, a prior form error).
 */
export function renderRepeatingBlock(html: string, blockName: string, rows: Array<Record<string, string>>): string {
  const start = `<!--BLOCK:${blockName}-->`;
  const end = `<!--/BLOCK:${blockName}-->`;
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end);
  if (startIndex === -1 || endIndex === -1) return html;

  const rowTemplate = html.slice(startIndex + start.length, endIndex);
  const rendered = rows.map((row) => renderTemplate(rowTemplate, row)).join('');
  return html.slice(0, startIndex) + rendered + html.slice(endIndex + end.length);
}
