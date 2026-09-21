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
//
// Issue #61: also closes the tab a couple of seconds after the blank, since
// the reveal action is single-use server-side (POST /v/:id/reveal consumes
// the id — see handleRevealPost) and there is nothing left to do here once
// the value is hidden again. The close is scheduled from INSIDE the blank's
// own setTimeout callback, after the blanking statements already ran, so it
// can never race the value-hiding guarantee — there is no independent timer
// that could fire early or out of order relative to the blank.
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
        status.textContent = 'Hidden. Closing this tab…';
        setTimeout(() => {
          window.close();
        }, 2000);
      }, 60000);
    } catch (err) {
      status.textContent = 'Network error.';
    }
  });
})();
`;
