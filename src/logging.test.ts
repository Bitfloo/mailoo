import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { __resetForTesting, bindServer, markInitialized, mcpLog, unbindServer } from './logging.js';
import createServer from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake McpServer with spies for `isConnected` and `sendLoggingMessage`. */
function createMockServer(connected = true) {
  return {
    isConnected: vi.fn(() => connected),
    sendLoggingMessage: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mcpLog', () => {
  beforeEach(() => {
    __resetForTesting();
  });

  it('drops messages when no server is bound', async () => {
    // No bindServer() called — should not throw
    await expect(mcpLog('info', 'test', 'hello')).resolves.toBeUndefined();
  });

  it('drops messages before markInitialized() is called', async () => {
    const mock = createMockServer(true);
    bindServer(mock as never);

    await mcpLog('info', 'test', 'should be dropped');

    expect(mock.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it('forwards messages after markInitialized() when connected', async () => {
    const mock = createMockServer(true);
    bindServer(mock as never);
    markInitialized();

    await mcpLog('info', 'server', 'Mailoo started');

    expect(mock.sendLoggingMessage).toHaveBeenCalledOnce();
    expect(mock.sendLoggingMessage).toHaveBeenCalledWith({
      level: 'info',
      logger: 'server',
      data: 'Mailoo started',
    });
  });

  it('drops messages when transport is not connected', async () => {
    const mock = createMockServer(false); // not connected
    bindServer(mock as never);
    markInitialized();

    await mcpLog('warning', 'test', 'no transport');

    expect(mock.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it('should deliver to the remaining sessions when one send fails', async () => {
    const failing = createMockServer(true);
    failing.sendLoggingMessage = vi.fn(async () => {
      throw new Error('transport closed');
    });
    const received: unknown[] = [];
    const healthy = {
      isConnected: () => true,
      sendLoggingMessage: async (params: { data: unknown }) => {
        received.push(params.data);
      },
    };
    bindServer(failing as never);
    markInitialized(failing as never);
    bindServer(healthy as never);
    markInitialized(healthy as never);

    await mcpLog('info', 'test', 'still delivered');

    expect(received).toEqual(['still delivered']);
  });

  it('swallows errors from sendLoggingMessage', async () => {
    const mock = createMockServer(true);
    mock.sendLoggingMessage = vi.fn(async () => {
      throw new Error('transport closed');
    });
    bindServer(mock as never);
    markInitialized();

    // Should resolve without throwing
    await expect(mcpLog('error', 'test', 'boom')).resolves.toBeUndefined();
  });
});

// HTTP mode binds one McpServer per session. A single module-wide reference
// sent every log to the session bound last, even after it had closed.
describe('mcpLog across HTTP sessions', () => {
  interface Session {
    server: McpServer;
    client: Client;
    received: unknown[];
  }

  const open: Session[] = [];

  async function connectSession(): Promise<Session> {
    const server = createServer();
    const client = new Client({ name: 'mailoo-logging', version: '0.0.0' });
    const received: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      received.push(notification.params.data);
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const session = { server, client, received };
    open.push(session);
    return session;
  }

  /** Notifications reach the client handler on a later tick. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  beforeEach(() => {
    __resetForTesting();
  });

  afterEach(async () => {
    await Promise.allSettled(open.flatMap((s) => [s.client.close(), s.server.close()]));
    open.length = 0;
  });

  it('should deliver to a live session when the session bound last has closed', async () => {
    const first = await connectSession();
    bindServer(first.server);
    markInitialized(first.server);
    const second = await connectSession();
    bindServer(second.server);
    markInitialized(second.server);
    await second.client.close();

    await mcpLog('info', 'test', 'after the second session closed');
    await flush();

    expect(first.received).toEqual(['after the second session closed']);
  });

  it('should not send to a session before its own handshake is marked', async () => {
    const first = await connectSession();
    bindServer(first.server);
    markInitialized(first.server);
    const second = await connectSession();
    bindServer(second.server);

    await mcpLog('info', 'test', 'first only');
    await flush();

    expect(second.received).toEqual([]);
  });

  it('should send to every initialized session when several are live', async () => {
    const first = await connectSession();
    const second = await connectSession();
    [first, second].forEach((session) => {
      bindServer(session.server);
      markInitialized(session.server);
    });

    await mcpLog('info', 'test', 'both');
    await flush();

    expect([first.received, second.received]).toEqual([['both'], ['both']]);
  });

  it('should stop sending to a session after unbindServer', async () => {
    const first = await connectSession();
    bindServer(first.server);
    markInitialized(first.server);
    unbindServer(first.server);

    await mcpLog('info', 'test', 'dropped');
    await flush();

    expect(first.received).toEqual([]);
  });

  it('should send to the bound stdio server when markInitialized has no argument', async () => {
    const only = await connectSession();
    bindServer(only.server);
    markInitialized();

    await mcpLog('info', 'test', 'stdio');
    await flush();

    expect(only.received).toEqual(['stdio']);
  });
});
