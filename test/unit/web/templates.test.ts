import { describe, expect, it } from 'vitest';
import { errorHtml, importFormHtml, requestDoneHtml, requestFormHtml, revealShellHtml } from '../../../src/web/templates/loaded.js';

const TEMPLATES = { errorHtml, importFormHtml, requestDoneHtml, requestFormHtml, revealShellHtml };

describe('templates', () => {
  it.each(Object.entries(TEMPLATES))('%s is real markup loaded as text, not an empty or literal specifier', (_name, html) => {
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('<!doctype html>');
  });

  it.each(Object.entries(TEMPLATES))('%s declares a mobile viewport (no horizontal scroll requirement)', (_name, html) => {
    expect(html).toContain('width=device-width, initial-scale=1');
  });

  it.each(Object.entries(TEMPLATES))('%s supports light/dark via prefers-color-scheme', (_name, html) => {
    expect(html).toMatch(/prefers-color-scheme/);
  });

  it('the reveal shell references the external static script, with no inline <script> body (CSP script-src \'self\')', () => {
    expect(revealShellHtml).toContain('<script src="/static/reveal.js"></script>');
    expect(revealShellHtml).not.toMatch(/<script>[^<]/);
  });

  it.each([
    ['errorHtml', errorHtml],
    ['requestDoneHtml', requestDoneHtml],
    ['requestFormHtml', requestFormHtml],
    ['revealShellHtml', revealShellHtml],
  ])('%s caps its layout width at max-width: 600px', (_name, html) => {
    expect(html).toContain('max-width: 600px');
  });

  it('importFormHtml caps its layout width at max-width: 800px (wider for the import form)', () => {
    expect(importFormHtml).toContain('max-width: 800px');
  });

  it('no template contains an inline <script> block', () => {
    for (const html of Object.values(TEMPLATES)) {
      expect(html).not.toMatch(/<script>[\s\S]*?[^\s][\s\S]*?<\/script>/);
    }
  });
});
