// Served verbatim at GET /static/reveal.js. Authored as a plain exported
// string (not a real .js asset file) because the project's esbuild loader
// map only text-loads `.html`; adding a blanket `.js` text loader there would
// break every other relative import in the bundle. This is JS source text,
// not HTML, so it does not fall under the "no HTML built by string
// concatenation in .ts" rule.
//
// Fetches the value once via POST /v/:id/reveal, shows it, and blanks it
// again after 60 seconds (PRD D2.4). The value never appears in this page's
// initial HTML, in a URL, or in a redirect.
export const REVEAL_CLIENT_JS = `(() => {
  const btn = document.getElementById('revealBtn');
  const box = document.getElementById('valueBox');
  const status = document.getElementById('status');
  if (!btn || !box || !status) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'Revealing...';
    const id = btn.getAttribute('data-id');
    try {
      const resp = await fetch('/v/' + encodeURIComponent(id) + '/reveal', { method: 'POST' });
      if (resp.status === 410) {
        status.textContent = 'This link has already been used.';
        return;
      }
      if (resp.status === 404) {
        status.textContent = 'This link has expired.';
        return;
      }
      if (!resp.ok) {
        status.textContent = 'Something went wrong.';
        return;
      }
      const data = await resp.json();
      box.textContent = data.value;
      box.hidden = false;
      status.textContent = 'Hides again in 60s.';
      setTimeout(() => {
        box.textContent = '';
        box.hidden = true;
        status.textContent = 'Hidden.';
      }, 60000);
    } catch (err) {
      status.textContent = 'Network error.';
    }
  });
})();
`;
