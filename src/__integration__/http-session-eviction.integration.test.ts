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
});
