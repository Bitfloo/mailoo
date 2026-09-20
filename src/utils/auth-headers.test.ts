import { parseSenderAuth, unfoldHeaders } from './auth-headers.js';

const FOLDED = [
  'From: Brand <noreply@brand.example>',
  'Reply-To: support@brand.example',
  'Return-Path: <bounce@mail.brand.example>',
  'Authentication-Results: mx.google.com;',
  '       spf=pass smtp.mailfrom=noreply@brand.example;',
  '       dkim=pass header.d=brand.example header.s=s1;',
  '       dkim=pass header.d=mailer.example;',
  '       dmarc=pass header.from=brand.example',
  'List-Unsubscribe: <https://brand.example/unsub?token=secret>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  '',
].join('\r\n');

describe('unfoldHeaders', () => {
  it('joins folded continuation lines', () => {
    const unfolded = unfoldHeaders('X-Foo: bar\r\n  baz\r\nX-Q: 1\r\n');
    expect(unfolded).toContain('X-Foo: bar baz');
    expect(unfolded).toContain('X-Q: 1');
  });
});

describe('parseSenderAuth', () => {
  it('parses folded Authentication-Results and repeated DKIM', () => {
    const signals = parseSenderAuth(FOLDED);
    expect(signals.fromDomain).toBe('brand.example');
    expect(signals.replyToDomain).toBe('brand.example');
    expect(signals.returnPathDomain).toBe('mail.brand.example');
    expect(signals.spf).toBe('pass');
    expect(signals.dmarc).toBe('pass');
    expect(signals.dkim).toEqual([
      { result: 'pass', domain: 'brand.example' },
      { result: 'pass', domain: 'mailer.example' },
    ]);
    expect(signals.hasListUnsubscribe).toBe(true);
    expect(signals.hasListUnsubscribePost).toBe(true);
    expect(JSON.stringify(signals)).not.toContain('https://brand.example/unsub');
  });

  it('returns empty auth results when headers are absent', () => {
    const signals = parseSenderAuth('From: a@b.example\r\n\r\n');
    expect(signals.fromDomain).toBe('b.example');
    expect(signals.spf).toBeUndefined();
    expect(signals.dmarc).toBeUndefined();
    expect(signals.dkim).toEqual([]);
    expect(signals.hasListUnsubscribe).toBe(false);
  });

  it('reports fail/softfail conservatively', () => {
    const raw = [
      'Authentication-Results: mx.example;',
      '       spf=fail smtp.mailfrom=spoof@evil.example;',
      '       dmarc=softfail',
      '',
    ].join('\r\n');
    const signals = parseSenderAuth(raw);
    expect(signals.spf).toBe('fail');
    expect(signals.dmarc).toBe('softfail');
  });
});
