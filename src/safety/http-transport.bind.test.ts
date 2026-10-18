import http from 'node:http';

import type { HttpListenPolicy } from './http-transport.js';
import { resolveHttpListen, startGuardedHttpServers } from './http-transport.js';

const realListen = http.Server.prototype.listen;

async function okHandler(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.end('ok');
}

function policyFor(hosts: string[]): HttpListenPolicy {
  return { ...resolveHttpListen({ port: 0 }), hosts };
}

/**
 * Every listen() is recorded; a host named in `failures` emits that errno code
 * instead of binding, so no test depends on which interfaces the machine has.
 */
function stubListen(failures: Record<string, string>): http.Server[] {
  const started: http.Server[] = [];
  vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function listen(
    this: http.Server,
    ...args: unknown[]
  ) {
    started.push(this);
    const { host } = args[0] as { host: string };
    const code = failures[host];
    if (code === undefined) return Reflect.apply(realListen, this, args) as http.Server;
    process.nextTick(() => {
      this.emit('error', Object.assign(new Error(`listen ${code} ${host}`), { code }));
    });
    return this;
  });
  return started;
}

function silenceStderr(): { mock: { calls: unknown[][] } } {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

function mailooLines(write: { mock: { calls: unknown[][] } }): string[] {
  return write.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('[mailoo]'));
}

describe('startGuardedHttpServers binding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A host without IPv6 still serves the loopback pair's IPv4 half.
  it.each(['EADDRNOTAVAIL', 'EAFNOSUPPORT'])(
    'should skip ::1 with a log line when it fails with %s after 127.0.0.1 bound',
    async (code) => {
      const write = silenceStderr();
      stubListen({ '::1': code });

      const listener = await startGuardedHttpServers(policyFor(['127.0.0.1', '::1']), okHandler);
      try {
        expect({
          bound: listener.addresses.map(({ address }) => address),
          logged: mailooLines(write),
        }).toEqual({
          bound: ['127.0.0.1'],
          logged: [`[mailoo] HTTP listen skipped for ::1 (${code})\n`],
        });
      } finally {
        await listener.close();
      }
    },
  );

  it('should refuse to start and close 127.0.0.1 when ::1 fails with another code', async () => {
    const started = stubListen({ '::1': 'EADDRINUSE' });

    await expect(
      startGuardedHttpServers(policyFor(['127.0.0.1', '::1']), okHandler),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(started.map((server) => server.listening)).toEqual([false, false]);
  });

  // With nothing bound yet, skipping ::1 would start a server that listens nowhere.
  it('should refuse to start with the bind error when ::1 is the first host', async () => {
    stubListen({ '::1': 'EADDRNOTAVAIL' });

    await expect(startGuardedHttpServers(policyFor(['::1']), okHandler)).rejects.toMatchObject({
      code: 'EADDRNOTAVAIL',
    });
  });

  it('should refuse to start and close the bound server when another host fails with EADDRNOTAVAIL', async () => {
    const started = stubListen({ '127.0.0.2': 'EADDRNOTAVAIL' });

    await expect(
      startGuardedHttpServers(policyFor(['127.0.0.1', '127.0.0.2']), okHandler),
    ).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' });
    expect(started.map((server) => server.listening)).toEqual([false, false]);
  });

  it('should refuse to start and close the server when it reports no port', async () => {
    const started = stubListen({});
    vi.spyOn(http.Server.prototype, 'address').mockReturnValueOnce(null);

    await expect(startGuardedHttpServers(policyFor(['127.0.0.1']), okHandler)).rejects.toThrow(
      'HTTP listen on 127.0.0.1 did not return a port',
    );
    expect(started.map((server) => server.listening)).toEqual([false]);
  });

  it('should refuse to start when the policy names no host', async () => {
    await expect(startGuardedHttpServers(policyFor([]), okHandler)).rejects.toThrow(
      'HTTP listen failed',
    );
  });

  it('should stop listening on every address when the listener closes', async () => {
    const listener = await startGuardedHttpServers(policyFor(['127.0.0.1']), okHandler);

    await listener.close();

    expect(listener.servers.map((server) => server.listening)).toEqual([false]);
  });

  // A startup error handler left attached would swallow a later server error.
  it('should leave no startup error listener on a bound server', async () => {
    const listener = await startGuardedHttpServers(policyFor(['127.0.0.1']), okHandler);
    try {
      expect(listener.servers.map((server) => server.listenerCount('error'))).toEqual([0]);
    } finally {
      await listener.close();
    }
  });
});
