import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  __resetForTesting,
  bindServer,
  boundServerCount,
  markInitialized,
  mcpLog,
  unbindServer,
} from './logging.js';
import createServer from './server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake McpServer with spies for `isConnected` and `sendLoggingMessage`. */
function createMockServer() {
  return {
    isConnected: vi.fn(() => true),
    sendLoggingMessage: vi.fn(async () => {}),
  };
}

/** Resolves after pending promise callbacks and rejection reports have run. */
async function nextTurn(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
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
    const mock = createMockServer();
    bindServer(mock as never);

    await mcpLog('info', 'test', 'should be dropped');

    expect(mock.sendLoggingMessage).not.toHaveBeenCalled();
  });

  it('forwards messages after markInitialized() when connected', async () => {
    const mock = createMockServer();
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

  it('should deliver to the remaining sessions when one send fails', async () => {
    const failing = createMockServer();
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

  // Without the await, mcpLog resolved before delivery and a send that failed
  // later escaped the catch as an unhandled rejection, which ends Node.
  it('should not resolve before a pending send settles', async () => {
    let finishSend: () => void = () => undefined;
    const server = {
      isConnected: () => true,
      sendLoggingMessage: async () =>
        new Promise<void>((resolve) => {
          finishSend = resolve;
        }),
    };
    bindServer(server as never);
    markInitialized(server as never);
    let resolved = false;

    const logged = mcpLog('info', 'test', 'pending').then(() => {
      resolved = true;
    });
    await nextTurn();
    const resolvedBeforeSend = resolved;
    finishSend();
    await logged;

    expect(resolvedBeforeSend).toBe(false);
  });

  it('should not leak a rejection when a send fails after mcpLog was called', async () => {
    let failSend: (error: Error) => void = () => undefined;
    const server = {
      isConnected: () => true,
      sendLoggingMessage: async () =>
        new Promise<void>((_resolve, reject) => {
          failSend = reject;
        }),
    };
    bindServer(server as never);
    markInitialized(server as never);
    const leaked: unknown[] = [];
    const onLeak = (reason: unknown): void => {
      leaked.push(reason);
    };
    process.on('unhandledRejection', onLeak);
    try {
      const logged = mcpLog('info', 'test', 'fails later');
      await nextTurn();
      failSend(new Error('transport closed'));
      await logged;
      await nextTurn();
    } finally {
      process.off('unhandledRejection', onLeak);
    }

    expect(leaked).toEqual([]);
  });

  it('swallows errors from sendLoggingMessage', async () => {
    const mock = createMockServer();
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

  // A real server without a transport cannot show a send: its call fails
  // inside mcpLog's catch. This one records the call it would have made.
  it('should skip a bound server whose transport is not connected', async () => {
    const sent: unknown[] = [];
    const detached = {
      isConnected: () => false,
      sendLoggingMessage: async (params: { data: unknown }) => {
        sent.push(params.data);
      },
    };
    bindServer(detached as never);
    markInitialized(detached as never);

    await mcpLog('warning', 'test', 'no transport');

    expect(sent).toEqual([]);
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

  // oninitialized can fire after the session was released; marking it then
  // must not put the closed session's server back into the table.
  it('should not re-add a server that was unbound before its handshake was marked', async () => {
    const late = await connectSession();
    bindServer(late.server);
    unbindServer(late.server);
    markInitialized(late.server);

    await mcpLog('info', 'test', 'after release');
    await flush();

    expect({ bound: boundServerCount(), received: late.received }).toEqual({
      bound: 0,
      received: [],
    });
  });

  it('should keep sending to a session that is bound again after its handshake', async () => {
    const only = await connectSession();
    bindServer(only.server);
    markInitialized(only.server);
    bindServer(only.server);

    await mcpLog('info', 'test', 'rebound');
    await flush();

    expect(only.received).toEqual(['rebound']);
  });

  it('should send to every bound server when markInitialized has no argument', async () => {
    const first = await connectSession();
    const second = await connectSession();
    bindServer(first.server);
    bindServer(second.server);
    markInitialized();

    await mcpLog('info', 'test', 'all');
    await flush();

    expect([first.received, second.received]).toEqual([['all'], ['all']]);
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
