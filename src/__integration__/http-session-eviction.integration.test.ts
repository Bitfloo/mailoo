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
});
