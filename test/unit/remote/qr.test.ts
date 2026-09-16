import { describe, expect, it } from 'vitest';
import { renderQrSvg } from '../../../src/remote/qr.js';

describe('renderQrSvg', () => {
  it('renders an inline <svg> (never a data: URI), so no CSP img-src exception is needed', () => {
    const svg = renderQrSvg('https://example.trycloudflare.com/r/abcdef0123456789abcdef0123456789');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    expect(svg).not.toContain('data:');
    expect(svg).not.toContain('<script');
  });

  it('is deterministic for the same input', () => {
    const url = 'https://foo.trycloudflare.com/r/00000000000000000000000000000000';
    expect(renderQrSvg(url)).toBe(renderQrSvg(url));
  });

  it('produces different markup for different URLs', () => {
    const a = renderQrSvg('https://foo.trycloudflare.com/r/00000000000000000000000000000000');
    const b = renderQrSvg('https://bar.trycloudflare.com/r/11111111111111111111111111111111');
    expect(a).not.toBe(b);
  });

  it('scales via viewBox rather than a fixed pixel size', () => {
    const svg = renderQrSvg('https://example.trycloudflare.com/r/abcdef0123456789abcdef0123456789');
    expect(svg).toContain('viewBox=');
  });
});
