import type { IncomingMessage, ServerResponse } from 'node:http';

import { send, TOKEN } from '../test-support/http-transport-harness.js';
import { readLimitedBody, resolveHttpListen, startGuardedHttpServers } from './http-transport.js';

async function okHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ok');
}

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
      expect(res.headers.allow).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      await listener.close();
    }
  });

  // The body is the JSON-RPC error a client parses.
  it.each([
    [
      'a foreign Host',
      {},
      (port: number) => ({ host: `rebind.example:${port}` }),
      'Invalid Host header',
    ],
    [
      'a missing bearer token',
      { token: TOKEN },
      (port: number) => ({ host: `127.0.0.1:${port}` }),
      'Unauthorized',
    ],
  ])(
    'should answer %s with a JSON-RPC -32000 error body',
    async (_case, extra, headers, message) => {
      const policy = resolveHttpListen({ port: 0, host: '127.0.0.1', ...extra });
      const listener = await startGuardedHttpServers(policy, okHandler);
      try {
        const res = await send(listener.port, headers(listener.port));

        expect(JSON.parse(res.body)).toEqual({
          jsonrpc: '2.0',
          error: { code: -32000, message },
          id: null,
        });
      } finally {
        await listener.close();
      }
    },
  );

  // The socket is destroyed after a refusal; the header tells a keep-alive client not to reuse it.
  it('should answer a refusal with Connection: close when the client asked for keep-alive', async () => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, okHandler);
    try {
      const res = await send(listener.port, {
        host: `rebind.example:${listener.port}`,
        connection: 'keep-alive',
      });

      expect(res.headers.connection).toBe('close');
    } finally {
      await listener.close();
    }
  });

  // RFC 9110 section 15.5.6: a 405 response must carry Allow, naming what the target supports.
  it.each([
    ['/mcp', 'GET, POST, DELETE'],
    ['/health', 'GET'],
  ])('should list %s methods in Allow when it refuses PUT with 405', async (path, allow) => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, okHandler);
    try {
      const host = `127.0.0.1:${listener.port}`;
      const res = await send(listener.port, { host }, { method: 'PUT', path });

      expect({ status: res.status, allow: res.headers.allow }).toEqual({ status: 405, allow });
    } finally {
      await listener.close();
    }
  });

  // GET, POST and DELETE on a path no route serves answer 404; another method must not
  // turn the same missing path into a 405 that names methods it does not have.
  it('should answer 404 without Allow when it refuses PUT on a path no route serves', async () => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, okHandler);
    try {
      const host = `127.0.0.1:${listener.port}`;
      const res = await send(listener.port, { host }, { method: 'PUT', path: '/other' });

      expect({ status: res.status, allow: res.headers.allow }).toEqual({
        status: 404,
        allow: undefined,
      });
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
