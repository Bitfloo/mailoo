import { applyBodyFormat } from './email-body.js';

describe('applyBodyFormat', () => {
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
});
