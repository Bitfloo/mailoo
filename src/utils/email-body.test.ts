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

  it('for full format, removes a spaced event handler', () => {
    const body = applyBodyFormat(undefined, '<p class="x" onerror="alert(1)">Hi</p>', 'full');
    expect(body.toLowerCase()).not.toContain('onerror');
    expect(body).toBe('<p class="x">Hi</p>');
  });

  it('for full format, removes an event handler glued to the previous attribute', () => {
    const doubled = applyBodyFormat(
      undefined,
      '<p class="x" onerror="a"onerror=alert(1)>Hi</p>',
      'full',
    );
    expect(doubled.toLowerCase()).not.toContain('onerror');
    expect(doubled).toBe('<p class="x">Hi</p>');

    const glued = applyBodyFormat(undefined, '<p class="x"onerror=alert(1)>Hi</p>', 'full');
    expect(glued.toLowerCase()).not.toContain('onerror');
    expect(glued).toBe('<p class="x">Hi</p>');

    const quoted = applyBodyFormat(undefined, "<p class='x'onclick='alert(1)'>Hi</p>", 'full');
    expect(quoted.toLowerCase()).not.toContain('onclick');
    expect(quoted).toBe("<p class='x'>Hi</p>");
  });

  it('for full format, keeps an https link and drops a javascript link', () => {
    expect(applyBodyFormat(undefined, '<a href="https://example.com/only">docs</a>', 'full')).toBe(
      '<a href="https://example.com/only">docs</a>',
    );
    expect(applyBodyFormat(undefined, '<a href="mailto:a@example.com">mail</a>', 'full')).toBe(
      '<a href="mailto:a@example.com">mail</a>',
    );
    expect(applyBodyFormat(undefined, '<a href="javascript:alert(1)">x</a>', 'full')).toBe(
      '<a>x</a>',
    );
  });

  it('for full format, keeps the letters on in attribute values and text', () => {
    const html = '<p title="only once">one ongoing note</p>';
    expect(applyBodyFormat(undefined, html, 'full')).toBe(html);
    const value = '<p title="say onerror=alert(1)">still here</p>';
    expect(applyBodyFormat(undefined, value, 'full')).toBe(value);
  });

  it('for full format, removes a handler or javascript URL separated by a slash', () => {
    expect(applyBodyFormat(undefined, '<p/onclick=alert(1)>Hi</p>', 'full')).toBe('<p>Hi</p>');
    expect(applyBodyFormat(undefined, '<a/href="javascript:alert(1)">x</a>', 'full')).toBe(
      '<a>x</a>',
    );
    expect(applyBodyFormat(undefined, '<a/href="https://example.com">x</a>', 'full')).toBe(
      '<a href="https://example.com">x</a>',
    );
  });

  it('for full format, removes an event handler whose name is entity-encoded', () => {
    expect(applyBodyFormat(undefined, '<p on&#99;lick="alert(1)">Hi</p>', 'full')).toBe(
      '<p>Hi</p>',
    );
    expect(applyBodyFormat(undefined, '<p on&#x63;lick="alert(1)">Hi</p>', 'full')).toBe(
      '<p>Hi</p>',
    );
    expect(applyBodyFormat(undefined, '<p on&#X43;lick="alert(1)">Hi</p>', 'full')).toBe(
      '<p>Hi</p>',
    );
    expect(applyBodyFormat(undefined, '<a href="&#106;avascript:alert(1)">x</a>', 'full')).toBe(
      '<a>x</a>',
    );
    expect(applyBodyFormat(undefined, '<a href="&#x6A;avascript:alert(1)">x</a>', 'full')).toBe(
      '<a>x</a>',
    );
  });

  it('for full format, decodes a numeric reference that has no semicolon', () => {
    expect(applyBodyFormat(undefined, '<p on&#99lick="alert(1)">Hi</p>', 'full')).toBe('<p>Hi</p>');
    expect(applyBodyFormat(undefined, '<p/on&#99lick=alert(1)>Hi</p>', 'full')).toBe('<p>Hi</p>');
    expect(applyBodyFormat(undefined, '<a h&#114ef="javascript:alert(1)">x</a>', 'full')).toBe(
      '<a>x</a>',
    );
    expect(
      applyBodyFormat(
        undefined,
        '<p st&#121le="background:url(javascript:alert(1))">Hi</p>',
        'full',
      ),
    ).toBe('<p>Hi</p>');
    expect(applyBodyFormat(undefined, '<p on&amp;#99;lick="alert(1)">Hi</p>', 'full')).toBe(
      '<p>Hi</p>',
    );
  });

  it('for full format, removes handlers with no space, mixed case, or a newline in the tag', () => {
    expect(applyBodyFormat(undefined, '<p OnClIcK="alert(1)">Hi</p>', 'full')).toBe('<p>Hi</p>');
    expect(applyBodyFormat(undefined, '<p\nclass="x"\nonclick="alert(1)">Hi</p>', 'full')).toBe(
      '<p\nclass="x">Hi</p>',
    );
    expect(applyBodyFormat(undefined, '<p onclick>Hi</p>', 'full')).toBe('<p>Hi</p>');
    expect(
      applyBodyFormat(
        undefined,
        '<p class="x" onclick="alert(1)" data-id="y" onmouseover="alert(2)">Hi</p>',
        'full',
      ),
    ).toBe('<p class="x" data-id="y">Hi</p>');
    expect(applyBodyFormat(undefined, '<p ononclick="alert(1)">Hi</p>', 'full')).toBe('<p>Hi</p>');
  });

  it('for full format, drops javascript and data URLs and keeps https and mailto', () => {
    expect(applyBodyFormat(undefined, '<a href="HTTPS://example.com/a?b=1">x</a>', 'full')).toBe(
      '<a href="HTTPS://example.com/a?b=1">x</a>',
    );
    expect(applyBodyFormat(undefined, '<a href="Mailto:a@example.com">x</a>', 'full')).toBe(
      '<a href="Mailto:a@example.com">x</a>',
    );
    expect(applyBodyFormat(undefined, '<a href="JaVaScRiPt:alert(1)">x</a>', 'full')).toBe(
      '<a>x</a>',
    );
    expect(applyBodyFormat(undefined, '<a href="data:text/html,x">x</a>', 'full')).toBe('<a>x</a>');
    expect(applyBodyFormat(undefined, '<a href="vbscript:msgbox(1)">x</a>', 'full')).toBe(
      '<a>x</a>',
    );
    expect(applyBodyFormat(undefined, '<a href="java&#10;script:alert(1)">x</a>', 'full')).toBe(
      '<a>x</a>',
    );
    expect(applyBodyFormat(undefined, '<a/href=https://example.com/docs>x</a>', 'full')).toBe(
      '<a href=https://example.com/docs>x</a>',
    );
    expect(applyBodyFormat(undefined, `<a href="https://example.com/?q='z'">x</a>`, 'full')).toBe(
      `<a href="https://example.com/?q='z'">x</a>`,
    );
    expect(applyBodyFormat(undefined, `<a href='https://example.com/?q="z"'>x</a>`, 'full')).toBe(
      `<a href='https://example.com/?q="z"'>x</a>`,
    );
  });

  it('for full format, removes a javascript formaction and a style expression', () => {
    expect(
      applyBodyFormat(undefined, '<button formaction="javascript:alert(1)">go</button>', 'full'),
    ).toBe('<button>go</button>');
    expect(
      applyBodyFormat(
        undefined,
        '<button FORMACTION="JAVASCRIPT:alert(1)" class="x">go</button>',
        'full',
      ),
    ).toBe('<button class="x">go</button>');
    expect(
      applyBodyFormat(undefined, '<button formaction="https://example.com/go">go</button>', 'full'),
    ).toBe('<button formaction="https://example.com/go">go</button>');
    expect(applyBodyFormat(undefined, '<input formaction="javascript:alert(1)">', 'full')).toBe(
      '<input>',
    );
    expect(
      applyBodyFormat(undefined, '<p style="background:url(javascript:alert(1))">Hi</p>', 'full'),
    ).toBe('<p>Hi</p>');
    expect(applyBodyFormat(undefined, '<p style="width:expression(alert(1))">Hi</p>', 'full')).toBe(
      '<p>Hi</p>',
    );
  });

  it('for full format, leaves safe markup intact and drops a tag that never closes', () => {
    expect(applyBodyFormat(undefined, '<p class="note"><strong>Hi</strong></p>', 'full')).toBe(
      '<p class="note"><strong>Hi</strong></p>',
    );
    expect(applyBodyFormat(undefined, '<input disabled>', 'full')).toBe('<input disabled>');
    expect(applyBodyFormat(undefined, 'Hi <p onclick=alert(1)', 'full')).not.toContain('onclick');
    expect(applyBodyFormat(undefined, 'Hi <p onclick=alert(1)', 'full')).not.toContain('alert');
  });

  it('for full format, still strips a style attribute', () => {
    expect(applyBodyFormat(undefined, '<p class="x" style="color:red">Hi</p>', 'full')).toBe(
      '<p class="x">Hi</p>',
    );
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
