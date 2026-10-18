/**
 * Log notifications across HTTP sessions: every live session that finished
 * its handshake receives them, and a closed session is released.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { boundServerCount, mcpLog } from '../logging.js';
import {
  initializeBody,
  openEventStream,
  postInitialize,
  postRpc,
  startHost,
} from './helpers/http-host.js';

// vi.waitFor's 1 s default would fail a stream that opens slowly on a loaded
// machine, so 5 s bounds only a stream that never opens. Each retry sends one
// more log, so retries are 100 ms apart rather than the default 50 ms.
const UNTIL_LOG_ARRIVES = { timeout: 5_000, interval: 100 };

// Each session binds its own McpServer for logging. One module-wide reference
// kept only the session bound last, so its close silenced every other client.
describe('HTTP session logging', () => {
  it('should deliver a log to a live session after the session bound last terminated', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const url = new URL(`http://127.0.0.1:${running.port}/mcp`);
    const live = new Client({ name: 'mailoo-live', version: '0.0.0' });
    const received: unknown[] = [];
    live.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      received.push(notification.params.data);
    });
    const endedTransport = new StreamableHTTPClientTransport(url);
    const ended = new Client({ name: 'mailoo-ended', version: '0.0.0' });
    try {
      await live.connect(new StreamableHTTPClientTransport(url));
      await ended.connect(endedTransport);
      await endedTransport.terminateSession();

      // The live client opens its notification stream asynchronously after the
      // handshake; repeat the log until that stream is up.
      await vi.waitFor(async () => {
        await mcpLog('info', 'test', 'after terminate');
        expect(received).toContain('after terminate');
      }, UNTIL_LOG_ARRIVES);
    } finally {
      await Promise.allSettled([live.close(), ended.close()]);
      await running.stop();
    }
  });
});

// A closed session's McpServer stayed in the logging table, so a long-lived
// host kept every server it ever created.
describe('HTTP session logging cleanup', () => {
  it('should unbind the session server from logging when the session terminates', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${running.port}/mcp`),
    );
    const client = new Client({ name: 'mailoo-unbind', version: '0.0.0' });
    const before = boundServerCount();
    try {
      await client.connect(transport);
      const connected = boundServerCount();
      await transport.terminateSession();

      await vi.waitFor(() => {
        expect({ connected, after: boundServerCount() }).toEqual({
          connected: before + 1,
          after: before,
        });
      });
    } finally {
      await client.close().catch(() => undefined);
      await running.stop();
    }
  });
});

// A session the transport never registers is never closed by it, so only the
// host can release the server openSession bound for logging.
describe('HTTP session logging when the session never registers', () => {
  it('should release the session server from logging when an initialize request is refused before the session registers', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const before = boundServerCount();
    try {
      // The SDK answers 406 before it registers a session when Accept lacks text/event-stream.
      const response = await postRpc(running.port, initializeBody(1), {
        accept: 'application/json',
      });

      await vi.waitFor(() => {
        expect({ status: response.status, bound: boundServerCount() }).toEqual({
          status: 406,
          bound: before,
        });
      });
    } finally {
      await running.stop();
    }
  });

  it('should release the session server from logging when session setup fails', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const before = boundServerCount();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(McpServer.prototype, 'connect').mockRejectedValueOnce(new Error('connect failed'));
    try {
      const response = await postInitialize(running.port, 1);

      await vi.waitFor(() => {
        expect({ status: response.status, bound: boundServerCount() }).toEqual({
          status: 500,
          bound: before,
        });
      });
    } finally {
      vi.restoreAllMocks();
      await running.stop();
    }
  });
});

// Logs before a client's `initialized` notification break clients that read
// stdout strictly; one session's handshake must not mark another session.
describe('HTTP session logging before the handshake', () => {
  it('should not send logs to a session that has not sent initialized when another session has', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const live = new Client({ name: 'mailoo-live', version: '0.0.0' });
    const received: unknown[] = [];
    live.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      received.push(notification.params.data);
    });
    let pendingStream: { text: () => string; close: () => void } | undefined;
    try {
      // The pending session is bound first, so marking every bound server
      // when the live client finishes its handshake would include it.
      const pending = await postInitialize(running.port, 1);
      pendingStream = await openEventStream(running.port, pending.sessionId);
      await live.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );

      // The live client opens its notification stream asynchronously after the
      // handshake; repeat each log until it arrives there.
      await vi.waitFor(async () => {
        await mcpLog('info', 'test', 'first');
        expect(received).toContain('first');
      }, UNTIL_LOG_ARRIVES);
      await vi.waitFor(async () => {
        await mcpLog('info', 'test', 'second');
        expect(received).toContain('second');
      }, UNTIL_LOG_ARRIVES);

      expect(pendingStream.text()).not.toContain('notifications/message');
    } finally {
      pendingStream?.close();
      await live.close().catch(() => undefined);
      await running.stop();
    }
  });
});
