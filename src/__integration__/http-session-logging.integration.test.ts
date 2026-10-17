/**
 * Log notifications across HTTP sessions: every live session that finished
 * its handshake receives them, and a closed session is released.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { boundServerCount, mcpLog } from '../logging.js';
import { openEventStream, postInitialize, startHost } from './helpers/http-host.js';

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
      await vi.waitFor(
        async () => {
          await mcpLog('info', 'test', 'after terminate');
          expect(received).toContain('after terminate');
        },
        { timeout: 5_000, interval: 100 },
      );
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
      await vi.waitFor(
        async () => {
          await mcpLog('info', 'test', 'first');
          expect(received).toContain('first');
        },
        { timeout: 5_000, interval: 100 },
      );
      await vi.waitFor(
        async () => {
          await mcpLog('info', 'test', 'second');
          expect(received).toContain('second');
        },
        { timeout: 5_000, interval: 100 },
      );

      expect(pendingStream.text()).not.toContain('notifications/message');
    } finally {
      pendingStream?.close();
      await live.close().catch(() => undefined);
      await running.stop();
    }
  });
});
