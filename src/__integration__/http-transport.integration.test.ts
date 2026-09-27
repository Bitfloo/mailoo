/**
 * Transport lane: the guarded HTTP listener on a real loopback socket.
 * GreenMail is unused here; this file lives in the integration config because
 * HTTP transport changes run with that suite.
 */

import http from 'node:http';

import { resolveHttpListen, startGuardedHttpServers } from '../safety/http-transport.js';

function send(
  port: number,
  headers: http.OutgoingHttpHeaders,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: '/health', headers },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP transport listener', () => {
  it('serves 127.0.0.1 and rejects a foreign Host', async () => {
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('up');
    });
    try {
      expect(listener.addresses.map((address) => address.address)).toEqual(['127.0.0.1']);
      const ok = await send(listener.port, { host: `127.0.0.1:${listener.port}` });
      expect(ok.status).toBe(200);
      expect(ok.body).toBe('up');
      const foreign = await send(listener.port, { host: `rebind.example:${listener.port}` });
      expect(foreign.status).toBe(403);
      expect(foreign.body).not.toContain('up');
    } finally {
      await listener.close();
    }
  });

  it('refuses to listen on 0.0.0.0 without a bearer token', () => {
    expect(() => resolveHttpListen({ port: 8080, host: '0.0.0.0' })).toThrow(
      /MCP_EMAIL_HTTP_TOKEN/,
    );
  });
});
