import LOOPBACK_HOSTNAMES from './loopback.js';

// Callers look up URL#hostname, which keeps the brackets around an IPv6 address.
describe('LOOPBACK_HOSTNAMES', () => {
  it.each(['http://127.0.0.1:8080/token', 'http://localhost/token', 'http://[::1]:8080/token'])(
    'should contain the hostname of %s',
    (url) => {
      expect(LOOPBACK_HOSTNAMES.has(new URL(url).hostname)).toBe(true);
    },
  );

  it.each(['http://localhost.example.com/token', 'http://10.0.0.5/token'])(
    'should not contain the hostname of %s',
    (url) => {
      expect(LOOPBACK_HOSTNAMES.has(new URL(url).hostname)).toBe(false);
    },
  );
});
