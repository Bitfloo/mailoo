import { applyBodyFormat, looksLikeRawMime, preferRicherPlain, stripHtml } from './email-body.js';

describe('looksLikeRawMime', () => {
  it('detects multipart boundary dumps', () => {
    expect(looksLikeRawMime('--_000_ABC\r\nContent-Type: text/plain')).toBe(true);
  });

  it('does not flag ordinary prose', () => {
    expect(looksLikeRawMime('Hello, please see the attached invoice.')).toBe(false);
  });

  it('does not treat -----Original Message----- as a MIME dump', () => {
    const quoted = 'Thanks for this.\n\n-----Original Message-----\nFrom: Bob\nHello';
    expect(looksLikeRawMime(quoted)).toBe(false);
  });
});

describe('preferRicherPlain', () => {
  it('keeps a reasonable plain-text body', () => {
    const plain = 'Meeting moved to Thursday at 3pm.';
    const html = '<p>Meeting moved to Thursday at 3pm.</p>';
    expect(preferRicherPlain(plain, html)).toBe(plain);
  });

  it('uses HTML when the plain part is a tiny fallback', () => {
    const plain = 'View this email in your browser.';
    const html =
      '<html><body><p>Full message content including important details and an expiry date of 2026-04-01.</p></body></html>';
    const chosen = preferRicherPlain(plain, html);
    expect(chosen).toContain('expiry date of 2026-04-01');
    expect(chosen).not.toBe(plain);
  });
});

describe('applyBodyFormat', () => {
  it('for text format, exposes HTML content hidden by a stub plain part', () => {
    const body = applyBodyFormat(
      'View this email in your browser.',
      '<p>Offer expires 2026-04-01. Terms apply.</p><p>More details in the full campaign.</p>',
      'text',
    );
    expect(body).toContain('Offer expires 2026-04-01');
  });

  it('for full format, skips raw MIME dumps in favour of HTML', () => {
    const raw = '--_000_BE0\r\nContent-Type: text/plain; charset="utf-8"\r\n\r\nSGkgSmFrb2I=';
    const html = '<p>Hi Jakob, please activate the account.</p>';
    expect(applyBodyFormat(raw, html, 'full')).toBe(html);
    expect(looksLikeRawMime(raw)).toBe(true);
  });

  it('keeps a text/plain body that quotes Original Message', () => {
    const body = 'See below.\n\n-----Original Message-----\nFrom: Alice\nCan we meet?';
    expect(applyBodyFormat(body, undefined, 'full')).toBe(body);
    expect(applyBodyFormat(body, undefined, 'text')).toContain('-----Original Message-----');
  });

  it('strips tags for text format when only HTML is present', () => {
    expect(applyBodyFormat(undefined, '<p>Hello <strong>world</strong></p>', 'text')).toContain(
      'Hello world',
    );
    expect(stripHtml('<p>Hello</p>')).toBe('Hello');
  });
});
