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
    '::1%lo0',
    '0.0.0.0',
    '128.0.0.1',
    '126.255.255.255',
    'localhost.example.com',
    '127.0.0.1.example.com',
    'mail.example.com',
    '',
  ])('should refuse %j', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
