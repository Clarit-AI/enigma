// Served verbatim at GET /static/request-form.js. Authored as a plain
// exported string, matching request-done-script.ts / reveal-script.ts: the
// project's esbuild loader map only text-loads `.html`, and a blanket `.js`
// text loader would break every other relative import in the bundle. This is
// JS source text, not HTML, so it does not fall under the "no HTML built by
// string concatenation in .ts" rule — the row markup itself lives in
// request-form.html as an inert <template>, and is only cloned here.
//
// Powers "+ Add secret" (Issue #71): each click appends one name/value row
// pair named `extra_name_N` / `extra_value_N`, which parseSubmission
// (src/web/body.ts) reads on submit. External and same-origin so CSP's
// `script-src 'self'` never needs `'unsafe-inline'`. Without script the
// button stays `hidden` and the pasted-blob textarea still works.
export const REQUEST_FORM_CLIENT_JS = `(() => {
  const button = document.getElementById('add-secret');
  const container = document.getElementById('extra-rows');
  const template = document.getElementById('extra-row-template');
  if (!button || !container || !(template instanceof HTMLTemplateElement)) return;

  let next = 1;
  button.hidden = false;
  button.addEventListener('click', () => {
    const row = template.content.cloneNode(true);
    const name = row.querySelector('[data-extra="name"]');
    const value = row.querySelector('[data-extra="value"]');
    if (!name || !value) return;
    name.name = 'extra_name_' + next;
    name.id = 'extra_name_' + next;
    value.name = 'extra_value_' + next;
    value.id = 'extra_value_' + next;
    next += 1;
    container.appendChild(row);
    name.focus();
  });
})();
`;
