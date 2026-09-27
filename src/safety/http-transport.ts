/**
 * Streamable HTTP listen policy.
 *
 * Loopback is the default because the process can read and send mail.
 * Any other address needs a bearer token configured out of band.
 * Host and Origin are taken from the request itself — forwarded headers
 * are client-controlled on this connection and are not a second source of truth.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';

/** One JSON-RPC POST, including a modest base64 attachment. Larger files use a path. */
export const DEFAULT_HTTP_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export const DEFAULT_HTTP_PORT = 8080;

/** Stalled header delivery must not hold the socket. Node's own default is 60s. */
export const HTTP_HEADERS_TIMEOUT_MS = 10_000;

/**
 * Stalled body delivery must not hold the socket.
 * This bounds receipt of the request, not an open SSE response.
 */
export const HTTP_REQUEST_TIMEOUT_MS = 60_000;

/** A header flood must not pin memory before the body limit applies. Node's default is 2000. */
export const HTTP_MAX_HEADER_COUNT = 100;

const LOOPBACK_BIND_HOSTS = ['127.0.0.1', '::1'] as const;

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'] as const;

const METHODS = new Set(['GET', 'POST', 'DELETE']);

const HOST_HEADER_RE =
  /^(?:\[([0-9a-f:]*)\]|([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*))(?::(\d{1,5}))?$/i;

export interface HttpListenPolicy {
  hosts: string[];
  port: number;
  token?: string;
  allowedHostnames: string[];
  /**
   * Names written in MCP_EMAIL_HTTP_ALLOWED_HOSTS, and a specific non-loopback bind.
   * A reverse proxy or a published container port does not use the listen port in Host.
   */
  portAgnosticHostnames: string[];
  bodyLimitBytes: number;
}

export interface HttpRequestHeaders {
  host?: string | string[];
  origin?: string | string[];
  authorization?: string | string[];
  'sec-fetch-site'?: string | string[];
  'content-type'?: string | string[];
  'content-length'?: string | string[];
}

export type HttpAccessDecision = { ok: true } | { ok: false; status: number; message: string };

export class HttpGuardError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpGuardError';
    this.status = status;
  }
}

export interface GuardedHttpListener {
  port: number;
  addresses: { address: string; port: number }[];
  servers: http.Server[];
  close: () => Promise<void>;
}

function refused(status: number, message: string): HttpAccessDecision {
  return { ok: false, status, message };
}

/**
 * A single colon plus a port is host:port. Bracketing that form makes the URL
 * parser treat it as IPv6 and reject names operators copy from a proxy or Docker.
 */
function hostTokenShape(trimmed: string): string {
  if (trimmed.startsWith('[')) return trimmed;
  if (/^[^:]+:\d{1,5}$/.test(trimmed)) return trimmed;
  if (trimmed.includes(':')) return `[${trimmed}]`;
  return trimmed;
}

function hostnameKey(host: string): string {
  const trimmed = host.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed) {
    throw new Error(`Invalid HTTP host: ${host}`);
  }
  let url: URL;
  try {
    url = new URL(`http://${hostTokenShape(trimmed)}`);
  } catch {
    throw new Error(`Invalid HTTP host: ${host}`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`Invalid HTTP host: ${host}`);
  }
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

function bindHost(host: string): string {
  const key = hostnameKey(host);
  if (key === '[::]') return '::';
  if (key.startsWith('[') && key.endsWith(']')) return key.slice(1, -1);
  return key;
}

function isWildcardBind(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

function isLoopbackBindHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (nums.some((n) => !Number.isInteger(n) || n > 255)) return false;
  return nums[0] === 127;
}

function normalizeToken(token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  const trimmed = token.trim();
  if (!trimmed) return undefined;
  if (!/^[!-~]+$/.test(trimmed)) {
    throw new Error('MCP_EMAIL_HTTP_TOKEN must be a single visible ASCII token');
  }
  return trimmed;
}

function addAllowed(allowed: string[], host: string): void {
  const key = hostnameKey(host);
  if (!allowed.includes(key)) allowed.push(key);
}

export function parseHttpPort(portArg: string | undefined): number {
  if (portArg === undefined) return DEFAULT_HTTP_PORT;
  if (!/^[0-9]+$/.test(portArg)) {
    throw new Error(`Invalid port: ${portArg}`);
  }
  const port = Number(portArg);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${portArg}`);
  }
  return port;
}

export function resolveHttpListen(input: {
  host?: string;
  port: number;
  token?: string;
  allowedHosts?: readonly string[];
  bodyLimitBytes?: number;
}): HttpListenPolicy {
  if (!Number.isInteger(input.port) || input.port < 0 || input.port > 65535) {
    throw new Error(`Invalid port: ${input.port}`);
  }

  const hosts = input.host?.trim() ? [bindHost(input.host)] : [...LOOPBACK_BIND_HOSTS];
  const token = normalizeToken(input.token);
  const exposed = hosts.filter((host) => !isLoopbackBindHost(host));
  if (exposed.length > 0 && !token) {
    throw new Error(`Refusing to listen on ${exposed.join(', ')} without MCP_EMAIL_HTTP_TOKEN`);
  }

  const allowed: string[] = [];
  const portAgnostic: string[] = [];
  if (exposed.length === 0) {
    LOOPBACK_HOSTNAMES.forEach((name) => {
      addAllowed(allowed, name);
    });
  }
  hosts.forEach((host) => {
    if (isWildcardBind(host) || isLoopbackBindHost(host)) return;
    addAllowed(allowed, host);
    addAllowed(portAgnostic, host);
  });
  hosts.forEach((host) => {
    if (
      !isLoopbackBindHost(host) ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === 'localhost'
    ) {
      return;
    }
    addAllowed(allowed, host);
  });
  (input.allowedHosts ?? []).forEach((host) => {
    if (host.trim()) {
      addAllowed(allowed, host);
      addAllowed(portAgnostic, host);
    }
  });

  if (hosts.some((host) => isWildcardBind(host)) && allowed.length === 0) {
    throw new Error('Refusing to listen on all interfaces without MCP_EMAIL_HTTP_ALLOWED_HOSTS');
  }

  const bodyLimitBytes = input.bodyLimitBytes ?? DEFAULT_HTTP_BODY_LIMIT_BYTES;
  if (!Number.isInteger(bodyLimitBytes) || bodyLimitBytes < 1) {
    throw new Error(`Invalid HTTP body limit: ${bodyLimitBytes}`);
  }

  return {
    hosts,
    port: input.port,
    token,
    allowedHostnames: allowed,
    portAgnosticHostnames: portAgnostic,
    bodyLimitBytes,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function readHttpLaunchOptions(
  args: { portArg?: string; hostArg?: string },
  env: NodeJS.ProcessEnv,
): HttpListenPolicy {
  const allowedHosts = env.MCP_EMAIL_HTTP_ALLOWED_HOSTS?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return resolveHttpListen({
    port: parseHttpPort(args.portArg),
    host: nonEmpty(args.hostArg) ?? nonEmpty(env.MCP_EMAIL_HTTP_HOST),
    token: env.MCP_EMAIL_HTTP_TOKEN,
    allowedHosts,
  });
}

function oneHeader(value: string | string[] | undefined): string | null | undefined {
  if (Array.isArray(value)) return null;
  return value;
}

function requestHostAllowed(hostname: string, port: number, policy: HttpListenPolicy): boolean {
  if (!policy.allowedHostnames.includes(hostname)) return false;
  if (policy.portAgnosticHostnames.includes(hostname)) return true;
  return port === policy.port;
}

/** Omitted port is the scheme default. Host is parsed as http, so a missing Host port is 80. */
function headerPort(url: URL): number {
  if (url.port !== '') return Number(url.port);
  if (url.protocol === 'https:') return 443;
  return 80;
}

function hostDecision(
  raw: string | null | undefined,
  policy: HttpListenPolicy,
): HttpAccessDecision | undefined {
  if (!raw) {
    return refused(403, 'Invalid Host header');
  }
  const match = HOST_HEADER_RE.exec(raw);
  const portPart = match?.[3];
  if (!match || (portPart !== undefined && portPart.length > 1 && portPart.startsWith('0'))) {
    return refused(403, 'Invalid Host header');
  }
  let url: URL;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    return refused(403, 'Invalid Host header');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return refused(403, 'Invalid Host header');
  }
  const port = headerPort(url);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!requestHostAllowed(hostname, port, policy)) {
    return refused(403, 'Invalid Host header');
  }
  return undefined;
}

function originDecision(
  raw: string | null | undefined,
  policy: HttpListenPolicy,
): HttpAccessDecision | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return refused(403, 'Invalid Origin header');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refused(403, 'Invalid Origin header');
  }
  if (
    raw !== url.origin ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    return refused(403, 'Invalid Origin header');
  }
  const port = headerPort(url);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!requestHostAllowed(hostname, port, policy)) {
    return refused(403, 'Invalid Origin header');
  }
  return undefined;
}

function secFetchDecision(raw: string | null | undefined): HttpAccessDecision | undefined {
  if (raw === null || raw?.trim().toLowerCase() === 'cross-site') {
    return refused(403, 'Forbidden');
  }
  return undefined;
}

function contentLengthValue(raw: string | string[] | undefined): number | undefined | 'invalid' {
  if (Array.isArray(raw)) return 'invalid';
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return 'invalid';
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) return 'invalid';
  return length;
}

function contentLengthDecision(
  raw: string | null | undefined,
  limit: number,
): HttpAccessDecision | undefined {
  const declared = raw === null ? 'invalid' : contentLengthValue(raw);
  if (declared === 'invalid') return refused(400, 'Invalid Content-Length');
  if (declared !== undefined && declared > limit) return refused(413, 'Payload too large');
  return undefined;
}

function contentTypeDecision(
  method: string,
  raw: string | null | undefined,
): HttpAccessDecision | undefined {
  if (method !== 'POST') return undefined;
  if (raw === null || raw === undefined) return refused(415, 'Unsupported media type');
  const media = raw.split(';')[0]?.trim().toLowerCase();
  if (media !== 'application/json') return refused(415, 'Unsupported media type');
  return undefined;
}

type BufferEqual = (left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => boolean;

export function bearerAuthorizationMatches(
  authorization: string | string[] | undefined,
  expected: string,
  equal: BufferEqual = (left, right) => timingSafeEqual(left, right),
): boolean {
  if (expected.length === 0) return false;
  const provided =
    typeof authorization === 'string' ? /^Bearer ([!-~]+)$/i.exec(authorization)?.[1] : undefined;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided ?? '', 'utf8');
  const sameLength = providedBuf.length === expectedBuf.length;
  // timingSafeEqual throws on unequal lengths; compare a zero buffer so a
  // wrong-length token costs the same time.
  const left = sameLength ? providedBuf : Buffer.alloc(expectedBuf.length);
  const equalBytes = equal(left, expectedBuf);
  return provided !== undefined && sameLength && equalBytes;
}

export type HttpRoute = 'health' | 'mcp' | 'missing' | 'method';

export function resolveHttpRoute(method: string | undefined, url: string | undefined): HttpRoute {
  if (url === '/health') return method === 'GET' ? 'health' : 'method';
  if (url === '/mcp') return method !== undefined && METHODS.has(method) ? 'mcp' : 'method';
  return 'missing';
}

export function evaluateHttpAccess(
  req: { method?: string; headers: HttpRequestHeaders },
  policy: HttpListenPolicy,
): HttpAccessDecision {
  const method = req.method ?? '';
  if (!METHODS.has(method)) return refused(405, 'Method not allowed');

  const host = hostDecision(oneHeader(req.headers.host), policy);
  if (host) return host;

  const origin = originDecision(oneHeader(req.headers.origin), policy);
  if (origin) return origin;

  const secFetch = secFetchDecision(oneHeader(req.headers['sec-fetch-site']));
  if (secFetch) return secFetch;

  const length = contentLengthDecision(
    oneHeader(req.headers['content-length']),
    policy.bodyLimitBytes,
  );
  if (length) return length;

  const contentType = contentTypeDecision(method, oneHeader(req.headers['content-type']));
  if (contentType) return contentType;

  if (policy.token && !bearerAuthorizationMatches(req.headers.authorization, policy.token)) {
    return refused(401, 'Unauthorized');
  }

  return { ok: true };
}

export async function readLimitedBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = contentLengthValue(req.headers['content-length']);
  if (declared === 'invalid') {
    throw new HttpGuardError(400, 'Invalid Content-Length');
  }
  if (declared !== undefined && declared > limit) {
    throw new HttpGuardError(413, 'Payload too large');
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    // Listeners and detach close over each other; declaration order is not call order.
    /* eslint-disable @typescript-eslint/no-use-before-define */
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    /* eslint-enable @typescript-eslint/no-use-before-define */

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.pause();
      reject(err);
    };

    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > limit) {
        fail(new HttpGuardError(413, 'Payload too large'));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: Error): void => {
      fail(err);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function jsonErrorBody(message: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

function rejectRequest(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  message: string,
): void {
  const body = jsonErrorBody(message);
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    Connection: 'close',
  };
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer';
  res.writeHead(status, headers);
  res.end(body, () => {
    req.destroy();
  });
}

async function listenOn(
  host: string,
  port: number,
  onRequest: http.RequestListener,
): Promise<http.Server> {
  const server = http.createServer(onRequest);
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.maxHeadersCount = HTTP_MAX_HEADER_COUNT;
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      // A failed listen is not a running server. close() would emit "Server is not running".
      reject(err);
    };
    server.once('error', onError);
    server.listen({ port, host }, () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function skippableV6(host: string, err: unknown): boolean {
  if (host !== '::1' || !(err instanceof Error) || !('code' in err)) return false;
  const code = String((err as NodeJS.ErrnoException).code);
  return code === 'EAFNOSUPPORT' || code === 'EADDRNOTAVAIL';
}

export function formatHttpListenLines(addresses: { address: string; port: number }[]): string {
  return addresses
    .map(({ address, port }) => {
      const host = address.includes(':') ? `[${address}]` : address;
      return [
        `mailoo HTTP server listening on ${host}:${port}`,
        `  Endpoint : http://${host}:${port}/mcp`,
        `  Health   : http://${host}:${port}/health`,
      ].join('\n');
    })
    .join('\n');
}

export async function startGuardedHttpServers(
  policy: HttpListenPolicy,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<GuardedHttpListener> {
  const active: HttpListenPolicy = {
    ...policy,
    allowedHostnames: [...policy.allowedHostnames],
    portAgnosticHostnames: [...policy.portAgnosticHostnames],
  };
  const servers: http.Server[] = [];
  const addresses: { address: string; port: number }[] = [];
  let boundPort = policy.port;

  const onRequest: http.RequestListener = (req, res) => {
    const decision = evaluateHttpAccess({ method: req.method, headers: req.headers }, active);
    if (!decision.ok) {
      rejectRequest(req, res, decision.status, decision.message);
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    handler(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpGuardError) {
        rejectRequest(req, res, err.status, err.message);
        return;
      }
      const name = err instanceof Error ? err.name : 'Error';
      process.stderr.write(`[mailoo] HTTP request failed: ${name}\n`);
      rejectRequest(req, res, 500, 'Internal error');
    });
  };

  // Port 0 is chosen by the first socket; the next address must reuse that port.
  let bindError: unknown;
  await policy.hosts.reduce<Promise<void>>(async (previous, host) => {
    await previous;
    if (bindError) return;
    try {
      const server = await listenOn(host, boundPort, onRequest);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        throw new Error(`HTTP listen on ${host} did not return a port`);
      }
      boundPort = address.port;
      active.port = address.port;
      servers.push(server);
      addresses.push({ address: address.address, port: address.port });
    } catch (err) {
      if (!(servers.length > 0 && skippableV6(host, err))) {
        bindError = err;
        return;
      }
      const code =
        err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : '';
      process.stderr.write(`[mailoo] HTTP listen skipped for ::1 (${code})\n`);
    }
  }, Promise.resolve());

  if (bindError instanceof Error) {
    await Promise.all(servers.map(async (server) => closeServer(server)));
    throw bindError;
  }

  if (servers.length === 0) {
    throw new Error('HTTP listen failed');
  }

  return {
    port: boundPort,
    addresses,
    servers,
    close: async () => {
      await Promise.all(servers.map(async (server) => closeServer(server)));
    },
  };
}
