import { deny, loopbackPolicy, TOKEN } from '../test-support/http-transport-harness.js';
import { evaluateHttpAccess, resolveHttpListen } from './http-transport.js';

describe('evaluateHttpAccess', () => {
  const policy = loopbackPolicy();

  it('allows a loopback Host on the listen port', () => {
    expect(
      evaluateHttpAccess({ method: 'GET', headers: { host: '127.0.0.1:8080' } }, policy).ok,
    ).toBe(true);
  });

  it('allows Host localhost on the listen port', () => {
    expect(
      evaluateHttpAccess({ method: 'GET', headers: { host: 'localhost:8080' } }, policy).ok,
    ).toBe(true);
  });

  it('allows Host [::1] on the listen port', () => {
    expect(evaluateHttpAccess({ method: 'GET', headers: { host: '[::1]:8080' } }, policy).ok).toBe(
      true,
    );
  });

  it('rejects a Host that is not an allowed name', () => {
    expect(
      deny(evaluateHttpAccess({ method: 'GET', headers: { host: 'rebind.example:8080' } }, policy)),
    ).toEqual({ status: 403, message: 'Invalid Host header' });
  });

  it('rejects a missing Host header', () => {
    expect(deny(evaluateHttpAccess({ method: 'GET', headers: {} }, policy)).status).toBe(403);
  });

  it('rejects a Host whose port is not the listen port', () => {
    expect(
      deny(evaluateHttpAccess({ method: 'GET', headers: { host: '127.0.0.1:9090' } }, policy))
        .status,
    ).toBe(403);
  });

  it('rejects Host 127.0.0.1:08080', () => {
    expect(
      deny(evaluateHttpAccess({ method: 'GET', headers: { host: '127.0.0.1:08080' } }, policy)),
    ).toEqual({ status: 403, message: 'Invalid Host header' });
  });

  it('rejects a duplicated Host header', () => {
    expect(
      deny(
        evaluateHttpAccess(
          { method: 'GET', headers: { host: ['127.0.0.1:8080', 'rebind.example:8080'] } },
          policy,
        ),
      ).status,
    ).toBe(403);
  });

  it('ignores X-Forwarded-Host when Host is not allowed', () => {
    const headers = {
      host: 'rebind.example:8080',
      'x-forwarded-host': '127.0.0.1:8080',
    };
    expect(deny(evaluateHttpAccess({ method: 'GET', headers }, policy)).status).toBe(403);
  });

  it('accepts Host 192.0.2.10:18080 when the process is bound to 192.0.2.10', () => {
    const bound = resolveHttpListen({ port: 8080, host: '192.0.2.10', token: TOKEN });
    expect(
      evaluateHttpAccess(
        {
          method: 'GET',
          headers: { host: '192.0.2.10:18080', authorization: `Bearer ${TOKEN}` },
        },
        bound,
      ).ok,
    ).toBe(true);
  });

  it('allows a non-loopback Host that was configured for that bind', () => {
    const policyOnLan = resolveHttpListen({ port: 9090, host: '192.0.2.10', token: TOKEN });
    expect(
      evaluateHttpAccess(
        {
          method: 'GET',
          headers: { host: '192.0.2.10:9090', authorization: `Bearer ${TOKEN}` },
        },
        policyOnLan,
      ).ok,
    ).toBe(true);
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'GET',
            headers: { host: 'rebind.example:9090', authorization: `Bearer ${TOKEN}` },
          },
          policyOnLan,
        ),
      ).status,
    ).toBe(403);
  });

  it('rejects a loopback Host that omits the listen port', () => {
    expect(
      deny(evaluateHttpAccess({ method: 'GET', headers: { host: '127.0.0.1' } }, policy)).status,
    ).toBe(403);
  });
});

describe('allowlisted hosts behind a proxy or a published port', () => {
  it('allows a Host without a port when that name is listed in MCP_EMAIL_HTTP_ALLOWED_HOSTS', () => {
    const policy = resolveHttpListen({
      port: 8080,
      host: '127.0.0.1',
      token: TOKEN,
      allowedHosts: ['mail.example'],
    });
    expect(
      evaluateHttpAccess(
        {
          method: 'GET',
          headers: { host: 'mail.example', authorization: `Bearer ${TOKEN}` },
        },
        policy,
      ).ok,
    ).toBe(true);
  });

  it('allows a published host:port when the process listens on another port', () => {
    // 443 is only how the name is written. 18080 is the published port; the process listens on 8080.
    const policy = resolveHttpListen({
      port: 8080,
      host: '0.0.0.0',
      token: TOKEN,
      allowedHosts: ['mail.example:443'],
    });
    expect(
      evaluateHttpAccess(
        {
          method: 'GET',
          headers: { host: 'mail.example:18080', authorization: `Bearer ${TOKEN}` },
        },
        policy,
      ).ok,
    ).toBe(true);
  });

  it('allows an https Origin for an allowlisted host behind a TLS proxy', () => {
    const policy = resolveHttpListen({
      port: 8080,
      host: '127.0.0.1',
      token: TOKEN,
      allowedHosts: ['mail.example'],
    });
    expect(
      evaluateHttpAccess(
        {
          method: 'POST',
          headers: {
            host: 'mail.example',
            origin: 'https://mail.example',
            'content-type': 'application/json',
            authorization: `Bearer ${TOKEN}`,
          },
        },
        policy,
      ).ok,
    ).toBe(true);
  });

  it('rejects a Host that is not listed, so a rebound name cannot pass', () => {
    const policy = resolveHttpListen({
      port: 8080,
      host: '0.0.0.0',
      token: TOKEN,
      allowedHosts: ['mail.example'],
    });
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'GET',
            headers: { host: 'rebind.example:18080', authorization: `Bearer ${TOKEN}` },
          },
          policy,
        ),
      ),
    ).toEqual({ status: 403, message: 'Invalid Host header' });
  });
});
