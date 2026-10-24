import { isLoopbackHost } from './loopback.js';

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'LocalHost',
    '127.0.0.1',
    '127.0.0.2',
    '127.255.255.254',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
  ])('should accept %j', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  // Only localhost and IP literals count: a client looks up any other spelling, '127.1' included, as a name.
  it.each([
    '127.1',
    '0x7f.0.0.1',
    '2130706433',
    '::ffff:127.0.0.1',
    'localhost.',
    '127.0.0.1.',
    ' localhost ',
    '127.0.0.1 ',
    '[127.0.0.1]',
    '[::1]:25',
    'x::1]',
    '[::1x',
    '::1]',
    '[::1',
    '::1%lo0',
    '0.0.0.0',
    '128.0.0.1',
    '126.255.255.255',
    'localhost.example.com',
    'evillocalhost',
    'app.localhost',
    '127.0.0.1.example.com',
    'mail.example.com',
    '',
  ])('should refuse %j', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  // The URL parser ends the host at ']' and drops tab, CR and LF, so each of these reads as [::1] there.
  it.each([
    '::1]:80/[',
    '[::1]:80/[]',
    '::1]/[',
    '::1]?[',
    '::1]#[',
    '::1\n',
    '\t::1',
    '::\t1',
    '::1\r',
  ])('should refuse %j, which the URL parser alone would read as ::1', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
