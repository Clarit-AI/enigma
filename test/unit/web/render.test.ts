import { describe, expect, it } from 'vitest';
import { escapeHtml, renderRepeatingBlock, renderTemplate } from '../../../src/web/templates/render.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert('&"')</script>`)).toBe(
      '&lt;script&gt;alert(&#39;&amp;&quot;&#39;)&lt;/script&gt;',
    );
  });
});

describe('renderTemplate', () => {
  it('substitutes a known token with its escaped value', () => {
    expect(renderTemplate('Hello {{NAME}}!', { NAME: '<b>world</b>' })).toBe('Hello &lt;b&gt;world&lt;/b&gt;!');
  });

  it('leaves an unmatched token untouched', () => {
    expect(renderTemplate('Hello {{MISSING}}!', {})).toBe('Hello {{MISSING}}!');
  });

  it('substitutes multiple distinct tokens', () => {
    expect(renderTemplate('{{A}}-{{B}}', { A: '1', B: '2' })).toBe('1-2');
  });
});

describe('renderRepeatingBlock', () => {
  const html = [
    '<ul>',
    '<!--BLOCK:ROW-->',
    '<li>{{NAME}}: {{DESC}}</li>',
    '<!--/BLOCK:ROW-->',
    '</ul>',
  ].join('\n');

  it('renders one copy of the block per row', () => {
    const rendered = renderRepeatingBlock(html, 'ROW', [
      { NAME: 'A', DESC: 'first' },
      { NAME: 'B', DESC: 'second' },
    ]);
    expect(rendered).toContain('<li>A: first</li>');
    expect(rendered).toContain('<li>B: second</li>');
    expect(rendered).not.toContain('BLOCK:ROW');
  });

  it('removes the section entirely for an empty rows array (if-block behavior)', () => {
    const rendered = renderRepeatingBlock(html, 'ROW', []);
    expect(rendered).toBe('<ul>\n\n</ul>');
  });

  it('escapes values inside repeated rows', () => {
    const rendered = renderRepeatingBlock(html, 'ROW', [{ NAME: '<x>', DESC: 'y' }]);
    expect(rendered).toContain('&lt;x&gt;');
    expect(rendered).not.toContain('<x>');
  });

  it('returns the input unchanged when the block markers are not found', () => {
    expect(renderRepeatingBlock('<p>no markers</p>', 'ROW', [{ A: '1' }])).toBe('<p>no markers</p>');
  });
});
