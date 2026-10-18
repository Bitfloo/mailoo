import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';

import { send } from '../test-support/http-transport-harness.js';
import type { GuardedHttpListener } from './http-transport.js';
import { HttpGuardError, resolveHttpListen, startGuardedHttpServers } from './http-transport.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

async function withListener(
  handler: Handler,
  run: (listener: GuardedHttpListener) => Promise<void>,
): Promise<void> {
  const listener = await startGuardedHttpServers(
    resolveHttpListen({ port: 0, host: '127.0.0.1' }),
    handler,
  );
  try {
    await run(listener);
  } finally {
    await listener.close();
  }
}

/** A GET that reports whether the response arrived whole instead of failing on an abort. */
async function fetchOutcome(port: number): Promise<{ status: number; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        res.on('error', () => {});
        res.resume();
        res.on('close', () => resolve({ status: res.statusCode ?? 0, complete: res.complete }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A POST that declares 1000 bytes, sends 10 and waits for the answer. */
async function postPartial(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': '1000',
        },
      },
      (res) => {
        res.resume();
        res.on('close', () => {
          req.destroy();
          resolve(res.statusCode ?? 0);
        });
      },
    );
    req.on('error', reject);
    req.write(Buffer.alloc(10));
  });
}

function stderrLines(write: { mock: { calls: unknown[][] } }): string[] {
  return write.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes('[mailoo]'));
}

describe('startGuardedHttpServers responses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The handler's own headers do not carry these; the guard adds them to every answer.
  it('should send nosniff and no-store on a response the handler wrote', async () => {
    await withListener(
      async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
      },
      async ({ port }) => {
        const res = await send(port, { host: `127.0.0.1:${port}` });

        expect({
          sniff: res.headers['x-content-type-options'],
          cache: res.headers['cache-control'],
        }).toEqual({ sniff: 'nosniff', cache: 'no-store' });
      },
    );
  });

  it('should send a Content-Length equal to the refusal body bytes', async () => {
    await withListener(
      async () => {},
      async ({ port }) => {
        const res = await send(port, { host: `rebind.example:${port}` });

        expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));
      },
    );
  });

  // The client is still uploading when the refusal goes out; the rest of its body is not read.
  it('should destroy a request it refuses while the body is still arriving', async () => {
    let seen: IncomingMessage | undefined;
    await withListener(
      async (req) => {
        seen = req;
        throw new HttpGuardError(413, 'Payload too large');
      },
      async ({ port }) => {
        const status = await postPartial(port);

        expect({ status, destroyed: seen?.destroyed }).toEqual({ status: 413, destroyed: true });
      },
    );
  });

  // A status line already went out, so the only honest signal left is a cut connection.
  it('should cut the connection without a log line when the handler fails after sending headers', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await withListener(
      async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.write('partial');
        throw new Error('mailbox secret fragment');
      },
      async ({ port }) => {
        const outcome = await fetchOutcome(port);

        expect({ outcome, logged: stderrLines(write) }).toEqual({
          outcome: { status: 200, complete: false },
          logged: [],
        });
      },
    );
  });

  // The error name says which kind of failure happened; the message may hold mail content.
  it.each([
    ['a TypeError', new TypeError('mailbox secret fragment'), 'TypeError'],
    ['a thrown string', 'mailbox secret fragment', 'Error'],
  ])('should log only the error name when the handler throws %s', async (_case, thrown, name) => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await withListener(
      async () => {
        // A dependency can reject with a value that is not an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw thrown;
      },
      async ({ port }) => {
        await send(port, { host: `127.0.0.1:${port}` });

        expect(stderrLines(write)).toEqual([`[mailoo] HTTP request failed: ${name}\n`]);
      },
    );
  });
});
