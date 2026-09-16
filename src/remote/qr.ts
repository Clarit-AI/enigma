// Renders the active public URL as an inline `<svg>` — never a `data:` URI
// `<img>` — so the request-form page's CSP (`default-src 'self'`,
// src/web/headers.ts) needs no `img-src` exception (docs/api-contracts.md
// §2). `qrcode-generator` (MIT, zero dependencies of its own, pure JS, no
// native code — see PR description for the reuse-ladder rationale) computes
// the module matrix and error-correction codewords; everything else here —
// the SVG markup shape and how it is embedded — is Enigma's own.
import qrcode from 'qrcode-generator';

/** `text` is the active public URL only — never combined with a request id in a form other than the path segment already present in that same URL (S2.3/leak criterion). */
export function renderQrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ scalable: true });
}
