// Real .html files bundled as text via the `?raw` import suffix, which the
// project's esbuild loader map (loader: { '.html': 'text' }) and vitest's
// built-in raw-asset handling both resolve identically with zero shared
// build/test config changes.
import requestFormHtml from './request-form.html?raw';
import requestDoneHtml from './request-done.html?raw';
import revealShellHtml from './reveal-shell.html?raw';
import errorHtml from './error.html?raw';

export { requestFormHtml, requestDoneHtml, revealShellHtml, errorHtml };
