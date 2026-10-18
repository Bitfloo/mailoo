import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  openEventStream,
  postInitialize,
  postRpc,
  startHost,
  TOOLS_LIST,
} from './helpers/http-host.js';

// An open event stream is a request in flight, which the session table never
// evicts however long ago the last POST was.
describe('HTTP session eviction', () => {
  const ttlMs = 5_000;

  it('should keep a session whose event stream is open after its idle TTL passes', async () => {
    const clock = { now: 1_000 };
    const running = await startHost(clock, ttlMs);
    let stream: { close: () => void } | undefined;
    try {
      const first = await postInitialize(running.port, 1);
      stream = await openEventStream(running.port, first.sessionId);
      clock.now = 1_000 + ttlMs + 1;
      await postInitialize(running.port, 2);

      const response = await postRpc(running.port, TOOLS_LIST, { sessionId: first.sessionId });

      expect(response.status).toBe(200);
    } finally {
      stream?.close();
      await running.stop();
    }
  });

  // Expired sessions are swept after every request, not only when a new
  // session opens; otherwise a busy client keeps every idle one alive.
  it('should answer 404 for an idle session when another session makes a request after the TTL passes', async () => {
    const clock = { now: 1_000 };
    const running = await startHost(clock, ttlMs);
    try {
      const active = await postInitialize(running.port, 1);
      const idle = await postInitialize(running.port, 2);
      clock.now = 1_000 + ttlMs + 1;

      const fromActive = await postRpc(running.port, TOOLS_LIST, { sessionId: active.sessionId });
      const fromIdle = await postRpc(running.port, TOOLS_LIST, { sessionId: idle.sessionId });

      expect({ active: fromActive.status, idle: fromIdle.status }).toEqual({
        active: 200,
        idle: 404,
      });
    } finally {
      await running.stop();
    }
  });

  // With the clock still, only the cap can drop a session: the new one stays
  // and the oldest idle one goes.
  it('should answer 404 for the oldest idle session when a new session goes over the cap', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs, undefined, 1);
    try {
      const first = await postInitialize(running.port, 1);
      const second = await postInitialize(running.port, 2);

      const fromFirst = await postRpc(running.port, TOOLS_LIST, { sessionId: first.sessionId });
      const fromSecond = await postRpc(running.port, TOOLS_LIST, { sessionId: second.sessionId });

      expect({ first: fromFirst.status, second: fromSecond.status }).toEqual({
        first: 404,
        second: 200,
      });
    } finally {
      await running.stop();
    }
  });

  // A session registers while its initialize request is still being handled;
  // until that request ends the session is in flight, not idle.
  it('should keep a session whose initialize request is still in flight when a second session goes over the cap', async () => {
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const original = StreamableHTTPServerTransport.prototype.handleRequest;
    vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockImplementationOnce(
      async function heldOpen(
        this: StreamableHTTPServerTransport,
        ...args: Parameters<StreamableHTTPServerTransport['handleRequest']>
      ) {
        await original.apply(this, args);
        await gate;
      },
    );
    const running = await startHost({ now: 1_000 }, ttlMs, undefined, 1);
    try {
      const first = await postInitialize(running.port, 1);
      await postInitialize(running.port, 2);
      openGate();

      const response = await postRpc(running.port, TOOLS_LIST, { sessionId: first.sessionId });

      expect(response.status).toBe(200);
    } finally {
      openGate();
      vi.restoreAllMocks();
      await running.stop();
    }
  });
});
