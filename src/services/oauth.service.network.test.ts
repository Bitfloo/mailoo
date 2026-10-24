import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { googleConfig, leakedSecretsIn } from '../test-support/token-endpoint.js';
import OAuthService from './oauth.service.js';

const USER = 'user-sentinel-0001';
const PASSWORD = 'pw-sentinel-0002';
const QUERY = 'query-sentinel-0003';

const TOKENS = { access_token: 'tok-moved', refresh_token: 'refresh-moved', expires_in: 3600 };

function customProvider(tokenUrl: string) {
  return googleConfig({
    provider: 'custom',
    tokenUrl,
    authUrl: 'https://auth.example.com/authorize',
  });
}

const FLOWS = [
  {
    action: 'token refresh',
    run: async (tokenUrl: string) => OAuthService.refreshAccessToken(customProvider(tokenUrl)),
  },
  {
    action: 'code exchange',
    run: async (tokenUrl: string) =>
      OAuthService.exchangeCode(customProvider(tokenUrl), 'auth-code', 'http://localhost:3000/cb'),
  },
] as const;

/** `/token` redirects to `/moved` with `status`; `/moved` hands out tokens. `/cut` stops mid-body. */
function answer(status: number): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const path = new URL(request.url ?? '/', 'http://loopback').pathname;
    if (path === '/token') {
      response.writeHead(status, { Location: `http://${request.headers.host}/moved` }).end();
    } else if (path === '/cut') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '200' });
      response.write('{"access_token":"', () => response.socket?.destroy());
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(TOKENS));
    }
  };
}

interface Loopback {
  base: string;
  paths: string[];
}

const servers: Server[] = [];

async function listeningPort(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function startLoopback(status = 307): Promise<Loopback> {
  const paths: string[] = [];
  const respond = answer(status);
  const port = await listeningPort(
    createServer((request, response) => {
      paths.push(new URL(request.url ?? '/', 'http://loopback').pathname);
      request.resume();
      respond(request, response);
    }),
  );
  return { base: `http://127.0.0.1:${port}`, paths };
}

/**
 * Held open until the test ends: a port freed before use can be bound by another process before
 * the request reaches it, and the request then gets an answer.
 */
async function droppingPort(): Promise<number> {
  const dropping = createServer();
  dropping.on('connection', (socket) => {
    socket.destroy();
  });
  return listeningPort(dropping);
}

afterEach(async () => {
  const running = servers.splice(0);
  await Promise.all(
    running.map(
      async (server) =>
        new Promise<void>((resolve) => {
          // fetch keeps the connection alive, and close() alone waits for it to go idle.
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  const error = await run().then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(error instanceof Error)) throw new Error('expected the call to reject');
  return error;
}

const UNREACHABLE = [
  {
    name: 'a URL with a user name, a password and a query',
    url: async ({ base }: Loopback) =>
      `${base.replace('http://', `http://${USER}:${PASSWORD}@`)}/token?k=${QUERY}`,
    reached: [],
  },
  {
    name: 'a port that drops every connection, with a query',
    url: async () => `http://127.0.0.1:${await droppingPort()}/token?k=${QUERY}`,
    reached: [],
  },
  {
    name: 'a malformed URL with a query',
    url: async () => `http://[::1/token?k=${QUERY}`,
    reached: [],
  },
  {
    name: 'a body cut off after its first bytes',
    url: async ({ base }: Loopback) => `${base}/cut?k=${QUERY}`,
    reached: ['/cut'],
  },
];

describe.each(FLOWS)(
  'OAuthService $action against a loopback token endpoint',
  ({ action, run }) => {
    it.each([{ status: 307 }, { status: 308 }])(
      'should refuse a $status answer without sending the request on to its Location',
      async ({ status }) => {
        const endpoint = await startLoopback(status);
        const outcome = await run(`${endpoint.base}/token`).then(
          () => 'resolved',
          (err: unknown) => (err instanceof Error ? err.message : String(err)),
        );
        expect({ outcome, paths: endpoint.paths }).toEqual({
          outcome: `OAuth2 ${action} failed (${status})`,
          paths: ['/token'],
        });
      },
    );

    it.each(UNREACHABLE)(
      'should name only an unreachable endpoint when the request fails on $name',
      async ({ url, reached }) => {
        const endpoint = await startLoopback();
        const tokenUrl = await url(endpoint);
        const error = await failureOf(async () => run(tokenUrl));
        expect({
          message: error.message,
          cause: error.cause,
          leaked: leakedSecretsIn(error, [USER, PASSWORD, QUERY, tokenUrl]),
          paths: endpoint.paths,
        }).toEqual({
          message: `OAuth2 ${action} failed: the token endpoint could not be reached`,
          cause: undefined,
          leaked: [],
          paths: reached,
        });
      },
    );
  },
);
