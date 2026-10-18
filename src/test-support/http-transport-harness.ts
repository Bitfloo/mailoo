/**
 * Helpers the http-transport unit suites share: the test token, the loopback
 * policy, the refusal unwrapper and a raw HTTP request to a started listener.
 */

import http from 'node:http';

import type { HttpAccessDecision, HttpListenPolicy } from '../safety/http-transport.js';
import { resolveHttpListen } from '../safety/http-transport.js';

export const TOKEN = 'test-token-value1';

export function deny(decision: HttpAccessDecision): { status: number; message: string } {
  expect(decision.ok).toBe(false);
  if (decision.ok) {
    throw new Error('expected the request to be refused');
  }
  return { status: decision.status, message: decision.message };
}

export function loopbackPolicy(
  overrides: { token?: string; bodyLimitBytes?: number } = {},
): HttpListenPolicy {
  return resolveHttpListen({ port: 8080, ...overrides });
}

export async function send(
  port: number,
  headers: http.OutgoingHttpHeaders,
  options: { method?: string; path?: string; body?: Buffer } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/mcp',
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
