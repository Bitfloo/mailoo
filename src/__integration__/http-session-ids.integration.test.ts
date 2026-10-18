/**
 * What the HTTP host answers for a session id it does not hold: unknown,
 * evicted, deleted by its client, or sent without one.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  initializeBody,
  postInitialize,
  postRpc,
  startHost,
  TOOLS_LIST,
} from './helpers/http-host.js';

// Streamable HTTP (2025-06-18, Session Management): an unknown or terminated
// session id gets 404, which tells the client to send a new initialize.
// A 400 left an evicted client with no way back.
describe('HTTP session ids the host does not hold', () => {
  const ttlMs = 5_000;

  it('should answer 404 with JSON-RPC error -32001 when the session id is unknown', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    try {
      const response = await postRpc(running.port, TOOLS_LIST, { sessionId: 'no-such-session' });

      expect({
        status: response.status,
        contentType: response.headers['content-type'],
        body: JSON.parse(response.body),
      }).toEqual({
        status: 404,
        contentType: 'application/json',
        body: { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
      });
    } finally {
      await running.stop();
    }
  });

  it('should answer 404 when the session was evicted after its idle TTL', async () => {
    const clock = { now: 1_000 };
    const running = await startHost(clock, ttlMs);
    try {
      const first = await postInitialize(running.port, 1);
      clock.now = 1_000 + ttlMs + 1;
      await postInitialize(running.port, 2);

      const response = await postRpc(running.port, TOOLS_LIST, { sessionId: first.sessionId });

      expect(response.status).toBe(404);
    } finally {
      await running.stop();
    }
  });

  it('should answer 404 when the client deleted its session', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${running.port}/mcp`),
    );
    const client = new Client({ name: 'mailoo-delete', version: '0.0.0' });
    try {
      await client.connect(transport);
      const sessionId = transport.sessionId ?? '';
      await transport.terminateSession();

      const response = await postRpc(running.port, TOOLS_LIST, { sessionId });

      expect(response.status).toBe(404);
    } finally {
      await client.close().catch(() => undefined);
      await running.stop();
    }
  });

  // The SDK answers a closed transport with the same 404, so only the table
  // shows whether the host forgot the session or kept it until eviction.
  it('should not close a session its client deleted again when the host closes', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${running.port}/mcp`),
    );
    const client = new Client({ name: 'mailoo-delete-close', version: '0.0.0' });
    const close = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');
    try {
      await client.connect(transport);
      await transport.terminateSession();
      const closesAfterDelete = close.mock.calls.length;

      await running.host.close();

      expect(close.mock.calls.length - closesAfterDelete).toBe(0);
    } finally {
      close.mockRestore();
      await client.close().catch(() => undefined);
      await running.stop();
    }
  });

  it('should answer 404 when an initialize request carries an unknown session id', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    try {
      const response = await postRpc(running.port, initializeBody(1), {
        sessionId: 'no-such-session',
      });

      expect(response.status).toBe(404);
    } finally {
      await running.stop();
    }
  });

  it('should keep 400 when a non-initialize request has no session id', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    try {
      const response = await postRpc(running.port, TOOLS_LIST);

      expect({
        status: response.status,
        contentType: response.headers['content-type'],
        body: JSON.parse(response.body),
      }).toEqual({
        status: 400,
        contentType: 'application/json',
        body: {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: provide mcp-session-id or send an initialize request',
          },
          id: null,
        },
      });
    } finally {
      await running.stop();
    }
  });
});
