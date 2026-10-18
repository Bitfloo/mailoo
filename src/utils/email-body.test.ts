import {
  applyBodyFormat,
  applyBodyFormatWithDefaultCap,
  DEFAULT_BODY_MAX_LENGTH,
  HTML_TRUNCATED_NOTE,
  looksLikeRawMime,
  MAX_HTML_INPUT_CHARS,
  preferRicherPlain,
  stripHtml,
} from './email-body.js';

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
    // MAX_DECODE_PASSES bounds the work on a deep entity chain; this residue is intended.
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

  it('should lowercase the HTML once per walk however many style blocks it drops', () => {
    // A newsletter with one <style> per table cell once lowercased the whole body per tag;
    // the walk runs on the single event loop, so every MCP session and the watcher stall with it.
    const replace = vi.spyOn(String.prototype, 'replace');
    try {
      stripHtml(`${'<style>a{}</style>'.repeat(1_000)}<p>Hello</p>`);
      const lowercasings = replace.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '[A-Z]+',
      );
      expect(lowercasings).toHaveLength(1);
    } finally {
      replace.mockRestore();
    }
  });

  it('should keep text after a script when a character before it lengthens on lowercasing', () => {
    // 'İ'.toLowerCase() is two code units, so a lowercased copy no longer lines up with the source.
    expect(stripHtml('<p>İ</p><script>x</script>Hi')).toBe('İ\n\nHi');
  });

  it('should convert an HTML part of exactly MAX_HTML_INPUT_CHARS without a cut note', () => {
    const html = `<p>${'A'.repeat(MAX_HTML_INPUT_CHARS - '<p></p>'.length)}</p>`;
    expect(stripHtml(html).length).toBe(MAX_HTML_INPUT_CHARS - '<p></p>'.length);
  });

  it('should convert at most MAX_HTML_INPUT_CHARS of HTML and say the rest was cut', () => {
    const text = stripHtml(`<p>${'A'.repeat(MAX_HTML_INPUT_CHARS + 1_000)}</p>`);
    expect({ length: text.length, tail: text.slice(-HTML_TRUNCATED_NOTE.length) }).toEqual({
      length: MAX_HTML_INPUT_CHARS - '<p>'.length + HTML_TRUNCATED_NOTE.length,
      tail: HTML_TRUNCATED_NOTE,
    });
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

  it('for full format, should sanitize at most MAX_HTML_INPUT_CHARS of HTML and say the rest was cut', () => {
    const body = applyBodyFormat(
      undefined,
      `<p>${'A'.repeat(MAX_HTML_INPUT_CHARS + 1_000)}</p>`,
      'full',
    );
    expect({ length: body.length, tail: body.slice(-HTML_TRUNCATED_NOTE.length) }).toEqual({
      length: MAX_HTML_INPUT_CHARS + HTML_TRUNCATED_NOTE.length,
      tail: HTML_TRUNCATED_NOTE,
    });
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

  it('caps at 20,000 characters by default in applyBodyFormatWithDefaultCap when maxLength is omitted', () => {
    const huge = 'X'.repeat(DEFAULT_BODY_MAX_LENGTH + 500);
    const out = applyBodyFormatWithDefaultCap(huge, undefined, 'text');
    expect(out).toBe(
      `${'X'.repeat(DEFAULT_BODY_MAX_LENGTH)}\n\n[Truncated at 20000 characters — pass a larger maxLength for the complete body]`,
    );
  });

  // The notice once offered format="full" as a way out, and a client that took it got the same cut.
  it('caps format="full" the same way when maxLength is omitted', () => {
    const huge = 'X'.repeat(DEFAULT_BODY_MAX_LENGTH + 500);
    expect(applyBodyFormatWithDefaultCap(huge, undefined, 'full')).toBe(
      applyBodyFormatWithDefaultCap(huge, undefined, 'text'),
    );
  });
});
