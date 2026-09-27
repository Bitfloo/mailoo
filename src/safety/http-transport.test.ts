import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import { Readable } from 'node:stream';
import type { HttpAccessDecision, HttpListenPolicy } from './http-transport.js';
import {
  bearerAuthorizationMatches,
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  evaluateHttpAccess,
  readHttpLaunchOptions,
  readLimitedBody,
  resolveHttpListen,
  resolveHttpRoute,
  startGuardedHttpServers,
} from './http-transport.js';

const TOKEN = 'test-token-value1';

function deny(decision: HttpAccessDecision): { status: number; message: string } {
  expect(decision.ok).toBe(false);
  if (decision.ok) {
    throw new Error('expected the request to be refused');
  }
  return { status: decision.status, message: decision.message };
}

function loopbackPolicy(
  overrides: { token?: string; bodyLimitBytes?: number } = {},
): HttpListenPolicy {
  return resolveHttpListen({ port: 8080, ...overrides });
}

function fakeRequest(chunks: Buffer[], headers: http.IncomingHttpHeaders = {}): IncomingMessage {
  const readable = Readable.from(chunks);
  return Object.assign(readable, { headers }) as IncomingMessage;
}

async function send(
  port: number,
  headers: http.OutgoingHttpHeaders,
  options: { method?: string; body?: Buffer } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: '/mcp',
        headers,
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(parts).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function okHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
}

describe('resolveHttpListen', () => {
  it('listens on 127.0.0.1 and ::1 when no host is configured', () => {
    const policy = resolveHttpListen({ port: 8080 });
    expect(policy.hosts).toEqual(['127.0.0.1', '::1']);
    expect(policy.token).toBeUndefined();
    expect(policy.allowedHostnames).toEqual(['127.0.0.1', 'localhost', '[::1]']);
  });

  it('accepts an explicit ::1 bind without a bearer token', () => {
    const policy = resolveHttpListen({ port: 8080, host: '::1' });
    expect(policy.hosts).toEqual(['::1']);
    expect(policy.token).toBeUndefined();
  });

  it('treats 127.0.0.2 as loopback and does not require a bearer token', () => {
    const policy = resolveHttpListen({ port: 8080, host: '127.0.0.2' });
    expect(policy.hosts).toEqual(['127.0.0.2']);
    expect(policy.token).toBeUndefined();
  });

  it('refuses to listen on 0.0.0.0 when no bearer token is configured', () => {
    expect(() => resolveHttpListen({ port: 8080, host: '0.0.0.0' })).toThrow(
      /MCP_EMAIL_HTTP_TOKEN/,
    );
  });

  it('refuses to listen on :: when the bearer token is blank', () => {
    expect(() => resolveHttpListen({ port: 8080, host: '::', token: '   ' })).toThrow(
      /MCP_EMAIL_HTTP_TOKEN/,
    );
  });

  it('refuses to listen on 192.0.2.10 when no bearer token is configured', () => {
    expect(() => resolveHttpListen({ port: 8080, host: '192.0.2.10' })).toThrow(
      /MCP_EMAIL_HTTP_TOKEN/,
    );
  });

  it('accepts 192.0.2.10 when a bearer token is configured', () => {
    const policy = resolveHttpListen({ port: 8080, host: '192.0.2.10', token: TOKEN });
    expect(policy.hosts).toEqual(['192.0.2.10']);
    expect(policy.token).toBe(TOKEN);
    expect(policy.allowedHostnames).toEqual(['192.0.2.10']);
  });

  it('refuses a wildcard bind when no allowed hosts are configured', () => {
    expect(() => resolveHttpListen({ port: 8080, host: '0.0.0.0', token: TOKEN })).toThrow(
      /MCP_EMAIL_HTTP_ALLOWED_HOSTS/,
    );
  });

  it('accepts a wildcard bind when a token and allowed hosts are configured', () => {
    const policy = resolveHttpListen({
      port: 8080,
      host: '0.0.0.0',
      token: TOKEN,
      allowedHosts: ['mail.example'],
    });
    expect(policy.hosts).toEqual(['0.0.0.0']);
    expect(policy.allowedHostnames).toEqual(['mail.example']);
  });

  it('caps the default request body at 8 MiB', () => {
    expect(DEFAULT_HTTP_BODY_LIMIT_BYTES).toBe(8 * 1024 * 1024);
    expect(resolveHttpListen({ port: 8080 }).bodyLimitBytes).toBe(DEFAULT_HTTP_BODY_LIMIT_BYTES);
  });
});

describe('readHttpLaunchOptions', () => {
  it('prefers the host argument over MCP_EMAIL_HTTP_HOST', () => {
    const policy = readHttpLaunchOptions(
      { portArg: '9090', hostArg: '192.0.2.10' },
      {
        MCP_EMAIL_HTTP_HOST: '198.51.100.20',
        MCP_EMAIL_HTTP_TOKEN: TOKEN,
      },
    );
    expect(policy.port).toBe(9090);
    expect(policy.hosts).toEqual(['192.0.2.10']);
  });

  it('uses MCP_EMAIL_HTTP_HOST when the command has no host argument', () => {
    const policy = readHttpLaunchOptions(
      { portArg: '8080' },
      { MCP_EMAIL_HTTP_HOST: '192.0.2.10', MCP_EMAIL_HTTP_TOKEN: TOKEN },
    );
    expect(policy.hosts).toEqual(['192.0.2.10']);
  });

  it('reads the bearer token from MCP_EMAIL_HTTP_TOKEN', () => {
    const policy = readHttpLaunchOptions(
      { portArg: '8080', hostArg: '192.0.2.10' },
      { MCP_EMAIL_HTTP_TOKEN: TOKEN },
    );
    expect(policy.token).toBe(TOKEN);
  });

  it('rejects a port that is not an integer in range', () => {
    expect(() => readHttpLaunchOptions({ portArg: '8080abc' }, {})).toThrow(/Invalid port/);
    expect(() => readHttpLaunchOptions({ portArg: '0' }, {})).toThrow(/Invalid port/);
    expect(() => readHttpLaunchOptions({ portArg: '65536' }, {})).toThrow(/Invalid port/);
  });

  it('defaults the port to 8080', () => {
    expect(readHttpLaunchOptions({}, {}).port).toBe(8080);
  });
});

describe('resolveHttpRoute', () => {
  it('accepts GET /health', () => {
    expect(resolveHttpRoute('GET', '/health')).toBe('health');
  });

  it('rejects DELETE /health', () => {
    expect(resolveHttpRoute('DELETE', '/health')).toBe('method');
  });

  it('accepts POST /mcp', () => {
    expect(resolveHttpRoute('POST', '/mcp')).toBe('mcp');
  });

  it('rejects an unknown path', () => {
    expect(resolveHttpRoute('GET', '/other')).toBe('missing');
  });
});

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
    expect(
      deny(
        evaluateHttpAccess(
          {
            method: 'GET',
            headers: {
              host: 'rebind.example:8080',
              'x-forwarded-host': '127.0.0.1:8080',
            },
          },
          policy,
        ),
      ).status,
    ).toBe(403);
  });

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
    expect(
      deny(evaluateHttpAccess({ method: 'TRACE', headers: { host: '127.0.0.1:8080' } }, policy))
        .status,
    ).toBe(405);
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
      allowedHosts: ['mail.example'],
    });
    expect(
      evaluateHttpAccess({ method: 'GET', headers: { host: 'mail.example' } }, policy).ok,
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

describe('bearerAuthorizationMatches', () => {
  it('accepts the configured token with a case-insensitive scheme', () => {
    expect(bearerAuthorizationMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('rejects a same-length token that differs by one character', () => {
    const wrong = `${TOKEN.slice(0, -1)}2`;
    expect(wrong.length).toBe(TOKEN.length);
    expect(bearerAuthorizationMatches(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  it('rejects a duplicated Authorization header', () => {
    expect(bearerAuthorizationMatches([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`], TOKEN)).toBe(false);
  });

  it('compares a different-length token with equal-sized buffers', () => {
    const sizes: number[] = [];
    const matches = bearerAuthorizationMatches('Bearer short', TOKEN, (left, right) => {
      sizes.push(left.byteLength, right.byteLength);
      return timingSafeEqual(left, right);
    });
    expect(matches).toBe(false);
    expect(sizes).toEqual([Buffer.byteLength(TOKEN), Buffer.byteLength(TOKEN)]);
  });
});

describe('readLimitedBody', () => {
  it('returns a body that is within the limit', async () => {
    const body = await readLimitedBody(fakeRequest([Buffer.from('{"jsonrpc":"2.0"}')]), 64);
    expect(body.toString('utf8')).toBe('{"jsonrpc":"2.0"}');
  });

  it('rejects streamed bytes one past the limit', async () => {
    const req = fakeRequest([Buffer.alloc(8), Buffer.alloc(1)]);
    await expect(readLimitedBody(req, 8)).rejects.toMatchObject({ status: 413 });
  });

  it('rejects a declared Content-Length over the limit before reading the stream', async () => {
    let pulled = false;
    const readable = new Readable({
      read() {
        pulled = true;
        this.push(null);
      },
    });
    const req = Object.assign(readable, {
      headers: { 'content-length': '100' },
    }) as IncomingMessage;
    await expect(readLimitedBody(req, 8)).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBe(false);
  });
});

describe('startGuardedHttpServers', () => {
  it('binds 127.0.0.1 and not every interface', async () => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, okHandler);
    try {
      expect(listener.addresses).toEqual([
        expect.objectContaining({ address: '127.0.0.1', port: listener.port }),
      ]);
      const res = await send(listener.port, { host: `127.0.0.1:${listener.port}` });
      expect(res.status).toBe(200);
      expect(res.body).toBe('ok');
    } finally {
      await listener.close();
    }
  });

  it('returns 403 for a foreign Host and does not run the handler', async () => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, okHandler);
    try {
      const res = await send(listener.port, { host: `rebind.example:${listener.port}` });
      expect(res.status).toBe(403);
      expect(res.body).toContain('Invalid Host header');
      expect(res.body).not.toContain('ok');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await listener.close();
    }
  });

  it('returns 403 for a foreign Origin', async () => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, okHandler);
    try {
      const res = await send(listener.port, {
        host: `127.0.0.1:${listener.port}`,
        origin: 'http://rebind.example',
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain('Invalid Origin header');
    } finally {
      await listener.close();
    }
  });

  it('returns 413 when a chunked body exceeds the limit', async () => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1', bodyLimitBytes: 32 });
    const listener = await startGuardedHttpServers(policy, async (req, res) => {
      await readLimitedBody(req, policy.bodyLimitBytes);
      await okHandler(req, res);
    });
    try {
      const res = await send(
        listener.port,
        {
          host: `127.0.0.1:${listener.port}`,
          'content-type': 'application/json',
        },
        { method: 'POST', body: Buffer.alloc(33) },
      );
      expect(res.status).toBe(413);
      expect(res.body).not.toContain('ok');
    } finally {
      await listener.close();
    }
  });

  it('returns 413 when Content-Length is over the limit', async () => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1', bodyLimitBytes: 32 });
    const listener = await startGuardedHttpServers(policy, async (req, res) => {
      await readLimitedBody(req, policy.bodyLimitBytes);
      await okHandler(req, res);
    });
    try {
      const res = await send(
        listener.port,
        {
          host: `127.0.0.1:${listener.port}`,
          'content-type': 'application/json',
          'content-length': '33',
        },
        { method: 'POST' },
      );
      expect(res.status).toBe(413);
      expect(res.body).not.toContain('ok');
    } finally {
      await listener.close();
    }
  });

  it('returns 401 when the bearer token is wrong', async () => {
    const policy = resolveHttpListen({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
    });
    const listener = await startGuardedHttpServers(policy, okHandler);
    try {
      const res = await send(listener.port, {
        host: `127.0.0.1:${listener.port}`,
        authorization: 'Bearer wrong-token-value',
      });
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.body).not.toContain(TOKEN);
      expect(res.body).not.toContain('ok');
    } finally {
      await listener.close();
    }
  });

  it('returns 200 when Host and bearer token match', async () => {
    const policy = resolveHttpListen({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
    });
    const listener = await startGuardedHttpServers(policy, okHandler);
    try {
      const res = await send(listener.port, {
        host: `127.0.0.1:${listener.port}`,
        authorization: `Bearer ${TOKEN}`,
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe('ok');
    } finally {
      await listener.close();
    }
  });

  it('does not return handler error text to the client', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, async () => {
      throw new Error('mailbox secret fragment');
    });
    try {
      const res = await send(listener.port, { host: `127.0.0.1:${listener.port}` });
      expect(res.status).toBe(500);
      expect(res.body).not.toContain('mailbox secret fragment');
      const logged = write.mock.calls.map((call) => String(call[0])).join('');
      expect(logged).not.toContain('mailbox secret fragment');
    } finally {
      write.mockRestore();
      await listener.close();
    }
  });

  it('bounds how long headers and the request body may take to arrive', async () => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, okHandler);
    try {
      expect(listener.servers[0]?.headersTimeout).toBe(10_000);
      expect(listener.servers[0]?.requestTimeout).toBe(60_000);
      expect(listener.servers[0]?.maxHeadersCount).toBe(100);
    } finally {
      await listener.close();
    }
  });
});

describe('HTTP entrypoint', () => {
  it('starts through the guarded listener and does not advertise every interface', async () => {
    const source = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    const host = await readFile(new URL('./http-mcp-host.ts', import.meta.url), 'utf8');
    expect(source).toContain('startGuardedHttpServers');
    expect(source).toContain('createHttpMcpHost');
    expect(host).toContain('readLimitedBody');
    expect(host).toContain('resolveHttpRoute');
    expect(source).not.toContain('http://0.0.0.0:');
    expect(source).not.toMatch(/\.listen\(\s*port\s*[,)]/);
    expect(host).not.toMatch(/\.listen\(\s*port\s*[,)]/);
  });

  it('documents loopback as the HTTP default', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const configuration = await readFile(
      new URL('../../docs/configuration.md', import.meta.url),
      'utf8',
    );
    expect(readme).toContain('127.0.0.1');
    expect(readme).toContain('MCP_EMAIL_HTTP_TOKEN');
    expect(configuration).toContain('::1');
    expect(configuration).toContain('MCP_EMAIL_HTTP_ALLOWED_HOSTS');
  });
});
