import { deny, loopbackPolicy, TOKEN } from '../test-support/http-transport-harness.js';
import { evaluateHttpAccess, resolveHttpListen } from './http-transport.js';

describe('evaluateHttpAccess', () => {
  const policy = loopbackPolicy();

  it('allows a request with no Origin header', () => {
    expect(
      evaluateHttpAccess({ method: 'GET', headers: { host: '127.0.0.1:8080' } }, policy).ok,
    ).toBe(true);
  });

  it('allows Origin http://127.0.0.1:8080', () => {
    expect(
      evaluateHttpAccess(
        {
          method: 'POST',
          headers: {
            host: '127.0.0.1:8080',
            origin: 'http://127.0.0.1:8080',
            'content-type': 'application/json',
          },
        },
        policy,
      ).ok,
    ).toBe(true);
  });

  it('rejects a foreign Origin', () => {
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'POST',
            headers: {
              host: '127.0.0.1:8080',
              origin: 'http://rebind.example',
              'content-type': 'application/json',
            },
          },
          policy,
        ),
      ),
    ).toEqual({ status: 403, message: 'Invalid Origin header' });
  });

  it('rejects Origin null', () => {
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'POST',
            headers: {
              host: '127.0.0.1:8080',
              origin: 'null',
              'content-type': 'application/json',
            },
          },
          policy,
        ),
      ).message,
    ).toBe('Invalid Origin header');
  });

  it.each(['http://127.0.0.1:8080/', 'http://127.0.0.1:8080/mcp'])(
    'rejects Origin %s, which has a path or a trailing slash',
    (origin) => {
      expect(
        deny(
          evaluateHttpAccess(
            { method: 'GET', headers: { host: '127.0.0.1:8080', origin } },
            policy,
          ),
        ),
      ).toEqual({ status: 403, message: 'Invalid Origin header' });
    },
  );

  it('should reject Origin ftp://127.0.0.1:8080 when its host and port match', () => {
    const headers = { host: '127.0.0.1:8080', origin: 'ftp://127.0.0.1:8080' };
    expect(deny(evaluateHttpAccess({ method: 'GET', headers }, policy))).toEqual({
      status: 403,
      message: 'Invalid Origin header',
    });
  });

  it('should allow https://127.0.0.1 when the listen port is 443 and refuse it when the port is 80', () => {
    const access = (port: number) =>
      evaluateHttpAccess(
        { method: 'GET', headers: { host: `127.0.0.1:${port}`, origin: 'https://127.0.0.1' } },
        resolveHttpListen({ port }),
      );
    expect({ on443: access(443).ok, on80: access(80).ok }).toEqual({ on443: true, on80: false });
  });

  it('rejects an Origin whose port is not the listen port', () => {
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'GET',
            headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:9090' },
          },
          policy,
        ),
      ).status,
    ).toBe(403);
  });

  it('rejects Sec-Fetch-Site cross-site', () => {
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'GET',
            headers: { host: '127.0.0.1:8080', 'sec-fetch-site': 'cross-site' },
          },
          policy,
        ),
      ),
    ).toEqual({ status: 403, message: 'Forbidden' });
  });

  it('rejects POST without an application/json content type', () => {
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'POST',
            headers: { host: '127.0.0.1:8080', 'content-type': 'text/plain' },
          },
          policy,
        ),
      ),
    ).toEqual({ status: 415, message: 'Unsupported media type' });
  });

  it('allows POST with application/json; charset=utf-8', () => {
    expect(
      evaluateHttpAccess(
        {
          method: 'POST',
          headers: {
            host: '127.0.0.1:8080',
            'content-type': 'application/json; charset=utf-8',
          },
        },
        policy,
      ).ok,
    ).toBe(true);
  });

  it('rejects a method other than GET, POST, or DELETE', () => {
    const req = { method: 'TRACE', url: '/mcp', headers: { host: '127.0.0.1:8080' } };
    expect(deny(evaluateHttpAccess(req, policy)).status).toBe(405);
  });

  it('rejects a Content-Length one byte over the configured limit', () => {
    const limited = resolveHttpListen({ port: 8080, bodyLimitBytes: 32 });
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'POST',
            headers: {
              host: '127.0.0.1:8080',
              'content-type': 'application/json',
              'content-length': '33',
            },
          },
          limited,
        ),
      ).status,
    ).toBe(413);
  });

  it('allows a Content-Length equal to the configured limit', () => {
    const limited = resolveHttpListen({ port: 8080, bodyLimitBytes: 32 });
    expect(
      evaluateHttpAccess(
        {
          method: 'POST',
          headers: {
            host: '127.0.0.1:8080',
            'content-type': 'application/json',
            'content-length': '32',
          },
        },
        limited,
      ).ok,
    ).toBe(true);
  });

  it('rejects a non-numeric Content-Length', () => {
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'POST',
            headers: {
              host: '127.0.0.1:8080',
              'content-type': 'application/json',
              'content-length': '12,12',
            },
          },
          policy,
        ),
      ).status,
    ).toBe(400);
  });

  it('returns 401 when a bearer token is required and Authorization is missing', () => {
    const guarded = loopbackPolicy({ token: TOKEN });
    expect(
      deny(evaluateHttpAccess({ method: 'GET', headers: { host: '127.0.0.1:8080' } }, guarded)),
    ).toEqual({ status: 401, message: 'Unauthorized' });
  });

  it('returns 401 when the bearer token does not match', () => {
    const guarded = loopbackPolicy({ token: TOKEN });
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'GET',
            headers: { host: '127.0.0.1:8080', authorization: 'Bearer wrong-token-value' },
          },
          guarded,
        ),
      ).message,
    ).toBe('Unauthorized');
  });

  it('allows a matching bearer token', () => {
    const guarded = loopbackPolicy({ token: TOKEN });
    expect(
      evaluateHttpAccess(
        {
          method: 'GET',
          headers: { host: '127.0.0.1:8080', authorization: `Bearer ${TOKEN}` },
        },
        guarded,
      ).ok,
    ).toBe(true);
  });
});
