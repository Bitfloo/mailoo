import { applyBodyFormat, looksLikeRawMime, preferRicherPlain, stripHtml } from './email-body.js';

const mimeBoundaryDump =
  '--_000_BE0\r\nContent-Type: text/plain; charset="utf-8"\r\n\r\nSGkgSmFrb2I=';

describe('looksLikeRawMime', () => {
  it('detects multipart boundary dumps', () => {
    expect(looksLikeRawMime('--_000_ABC\r\nContent-Type: text/plain')).toBe(true);
  });

  it('detects boundary dumps used in full-format fixtures', () => {
    expect(looksLikeRawMime(mimeBoundaryDump)).toBe(true);
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

  it('uses HTML-derived text when the plain part is a tiny fallback', () => {
    const plain = 'View this email in your browser.';
    const html =
      '<html><body><p>Full message content including important details and an expiry date of 2026-04-01.</p></body></html>';
    expect(preferRicherPlain(plain, html)).toContain('expiry date of 2026-04-01');
  });

  it('does not keep the stub plain when HTML carries the message', () => {
    const plain = 'View this email in your browser.';
    const html =
      '<html><body><p>Full message content including important details and an expiry date of 2026-04-01.</p></body></html>';
    expect(preferRicherPlain(plain, html)).not.toBe(plain);
  });
});

describe('stripHtml', () => {
  it('removes tags and keeps text content', () => {
    expect(stripHtml('<p>Hello</p>')).toBe('Hello');
  });

  it('decodes a named entity in text', () => {
    expect(stripHtml('<p>a &amp; b</p>')).toBe('a & b');
  });

  it('drops script content when the closing tag is missing', () => {
    expect(stripHtml('<p>Hello</p><script>alert(1)')).toBe('Hello');
  });

  it('does not leave an encoded script tag in the text', () => {
    const text = stripHtml('&lt;script&gt;alert(1)&lt;/script&gt;<p>Hello</p>');
    expect(text).not.toMatch(/<script/i);
    expect(text).not.toContain('alert(1)');
    expect(text).toContain('Hello');
  });

  it('removes a script tag hidden under three entity layers', () => {
    expect(stripHtml('&amp;amp;lt;script&amp;amp;gt;z&amp;amp;lt;/script&amp;amp;gt;')).toBe('');
  });

  it('leaves a fourth entity layer as text', () => {
    // The pass ceiling keeps a deep entity chain linear; a fourth layer stays text.
    expect(
      stripHtml('&amp;amp;amp;lt;script&amp;amp;amp;gt;w&amp;amp;amp;lt;/script&amp;amp;amp;gt;'),
    ).toBe('&lt;script&gt;w&lt;/script&gt;');
  });

  it('drops a style block and its remote URL', () => {
    expect(stripHtml('<style>@import url(https://evil.example/a.css);</style>Hi')).toBe('Hi');
    expect(stripHtml('<style>@import url(https://evil.example/a.css)')).not.toContain(
      'evil.example',
    );
  });

  it('drops an unclosed tag that points at a remote resource', () => {
    expect(stripHtml('<p>Hi</p><img src="https://evil.example/pixel.gif"')).toBe('Hi');
  });

  it('drops script in a body larger than a megabyte and keeps all of the text', () => {
    const letters = 'A'.repeat(2_000_000);
    const text = stripHtml(`<script>alert(1)</script><p>${letters}</p>`);
    expect(text).not.toContain('alert(1)');
    expect(text).toBe(letters);
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

  it('for full format, drops script, style, and remote resources', () => {
    const html =
      '<p>Hello</p><script>alert(1)</script><style>@import "https://evil.example/a.css";</style><img src="https://evil.example/p.png">';
    expect(applyBodyFormat(undefined, html, 'full')).toBe('<p>Hello</p>');
  });

  it('for full format, skips raw MIME dumps in favour of HTML', () => {
    const html = '<p>Hi Jakob, please activate the account.</p>';
    expect(applyBodyFormat(mimeBoundaryDump, html, 'full')).toBe(html);
  });

  it('for full format, keeps a text/plain body that quotes Original Message', () => {
    const body = 'See below.\n\n-----Original Message-----\nFrom: Alice\nCan we meet?';
    expect(applyBodyFormat(body, undefined, 'full')).toBe(body);
  });

  it('for text format, keeps Original Message separator in the body', () => {
    const body = 'See below.\n\n-----Original Message-----\nFrom: Alice\nCan we meet?';
    expect(applyBodyFormat(body, undefined, 'text')).toContain('-----Original Message-----');
  });

  it('for stripped format, drops quoted lines and signature separators', () => {
    const body = 'New reply here.\n\n> quoted earlier text\n\n-- \nSent from my phone';
    expect(applyBodyFormat(body, undefined, 'stripped')).toBe('New reply here.');
  });

  it('for text format, strips tags when only HTML is present', () => {
    expect(applyBodyFormat(undefined, '<p>Hello <strong>world</strong></p>', 'text')).toContain(
      'Hello world',
    );
  });

  it('for text format, keeps paragraph text when HTML starts with a data-URI image larger than a megabyte', () => {
    const html = `<img src="data:image/png;base64,${'A'.repeat(1_100_000)}"><p>Meet at noon.</p>`;
    expect(applyBodyFormat(undefined, html, 'text')).toBe('Meet at noon.');
  });

  it('for full format, keeps the paragraph when HTML starts with a data-URI image larger than a megabyte', () => {
    const html = `<img src="data:image/png;base64,${'A'.repeat(1_100_000)}"><p>Meet at noon.</p>`;
    expect(applyBodyFormat(undefined, html, 'full')).toBe('<p>Meet at noon.</p>');
  });

  it('truncates the body and reports remaining characters when maxLength is exceeded', () => {
    const bodyText =
      'Offer expires 2026-04-01. Terms apply. More details in the full campaign follow-up including eligibility, refund windows, and the activation steps for each recipient.';
    const maxLength = 100;
    const remaining = bodyText.length - maxLength;
    expect(applyBodyFormat(bodyText, undefined, 'full', maxLength)).toBe(
      `${bodyText.slice(0, maxLength)}\n\n… (${remaining} more characters — increase maxLength to read the full body)`,
    );
  });

  it('leaves the body intact when its length equals maxLength', () => {
    const maxLength = 100;
    const source =
      'Offer expires 2026-04-01. Terms apply. More details in the full campaign follow-up including eligibility, refund windows, and the activation steps for each recipient.';
    const bodyText = source.slice(0, maxLength);
    expect(applyBodyFormat(bodyText, undefined, 'full', maxLength)).toBe(bodyText);
  });

  it('leaves the body intact when maxLength is not positive', () => {
    const bodyText =
      'Offer expires 2026-04-01. Terms apply. More details in the full campaign follow-up including eligibility, refund windows, and the activation steps for each recipient.';
    expect(applyBodyFormat(bodyText, undefined, 'full', 0)).toBe(bodyText);
  });
});
