/**
 * Stand-ins for an OAuth2 token endpoint, stubbed in as the global `fetch`, and the account
 * OAuth2 config the OAuthService suites send to it.
 */

import { inspect } from 'node:util';

import type { OAuth2Config } from '../types/index.js';

export interface TokenRequest {
  url: string;
  init: RequestInit;
}

/** Token endpoint stand-in: answers each POST with the next scripted response. */
export function fakeTokenEndpoint(
  ...responses: ((request: TokenRequest) => Response)[]
): TokenRequest[] {
  const calls: TokenRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const request = { url, init };
    calls.push(request);
    const next = responses.shift();
    if (!next) throw new Error('unexpected token request');
    return next(request);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

/** A fetch that never answers until its signal aborts, like a stalled token endpoint. */
export function stalledTokenEndpoint(): void {
  async function neverAnswer(_url: string, init: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason);
      });
    });
  }
  vi.stubGlobal('fetch', vi.fn(neverAnswer));
}

/** Sends the status line, then the request timeout fires while the body is being read. */
export function stalledBody(status: number): () => Response {
  return function stalledResponse() {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        );
      },
    });
    return new Response(body, { status });
  };
}

/** Fake secrets a sloppy token endpoint or proxy could echo; none may appear in an error. */
export const LEAKED_SECRETS = [
  'SENTINEL-ACCESS-0001',
  'SENTINEL-REFRESH-0002',
  'SENTINEL-ID-0003',
] as const;

/** An RFC 6749 §5.2 error body that also echoes the token fields. */
export function leakyInvalidGrant(status = 400): () => Response {
  const [accessToken, refreshToken, idToken] = LEAKED_SECRETS;
  return () =>
    Response.json(
      {
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: idToken,
      },
      { status },
    );
}

/** A 400 refusal built from the form the request sent, as an endpoint that echoes its input. */
export function echoingRefusal(
  fields: (sent: URLSearchParams, form: string) => Record<string, unknown>,
): (request: TokenRequest) => Response {
  return ({ init }) => {
    const form = String(init.body);
    return Response.json(fields(new URLSearchParams(form), form), { status: 400 });
  };
}

/**
 * An RFC 6749 §5.2 error body whose other fields, the vendor extras included, hold fake secrets
 * and one numeric code. Only `error` and `error_description` may reach an error.
 */
export const HOSTILE_REFUSAL = {
  error: 'invalid_grant',
  error_description: 'Token has been expired or revoked.',
  error_uri: 'https://auth.example.test/errors/SENTINEL-URI-0004',
  error_codes: [90_412_873],
  trace_id: 'SENTINEL-TRACE-0005',
  correlation_id: 'SENTINEL-CORRELATION-0006',
  message: 'SENTINEL-MESSAGE-0007',
  detail: 'SENTINEL-DETAIL-0008',
  reason: 'SENTINEL-REASON-0009',
  errors: [{ message: 'SENTINEL-NESTED-0010' }],
  access_token: LEAKED_SECRETS[0],
  refresh_token: LEAKED_SECRETS[1],
  id_token: LEAKED_SECRETS[2],
} as const;

function leafTexts(value: unknown): string[] {
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(leafTexts);
  return [String(value)];
}

/** Every value of a refusal body outside `error` and `error_description`, numbers as text. */
export function valuesBesidesErrorFields(body: Record<string, unknown>): string[] {
  return Object.entries(body)
    .filter(([field]) => field !== 'error' && field !== 'error_description')
    .flatMap(([, value]) => leafTexts(value));
}

/**
 * The strings reachable from a value: strings, bytes decoded as UTF-8 (`inspect` prints a Buffer
 * as hex and stops after 50), and the own data properties of each object, string- or
 * symbol-keyed, enumerable or not, so an error's `message` and `cause` are followed. Map keys and
 * values and Set items are walked too. A visited object is skipped, so a cycle ends and nesting
 * has no depth cap. Accessors are skipped, never invoked: reading one could run code. Inherited
 * properties, private fields and internal slots are not walked; a one-level `inspect` of each
 * object stands in for the part of them it prints: the stack (an accessor) that outlives an edited
 * message, and the state a Headers or URL keeps out of its own properties.
 */
function stringsIn(root: unknown): string[] {
  const strings: string[] = [];
  const visited = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') strings.push(value);
    if (value instanceof ArrayBuffer) strings.push(Buffer.from(value).toString('utf8'));
    if (ArrayBuffer.isView(value)) {
      strings.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8'));
    }
    if (typeof value === 'object' && value !== null && !visited.has(value)) {
      visited.add(value);
      strings.push(inspect(value, { depth: 0 }));
      if (value instanceof Map) pending.push(...value.keys(), ...value.values());
      if (value instanceof Set) pending.push(...value);
      Reflect.ownKeys(value).forEach((key) => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (property && 'value' in property) pending.push(property.value);
      });
    }
  }
  return strings;
}

const LEAK_FRAGMENT_CHARS = 8;

function fragmentsOf(secret: string): string[] {
  return Array.from({ length: Math.max(1, secret.length - LEAK_FRAGMENT_CHARS + 1) }, (_, start) =>
    secret.slice(start, start + LEAK_FRAGMENT_CHARS),
  );
}

/**
 * The secrets found in the strings reachable from a value (see `stringsIn`): an error with its
 * causes and own data properties, or plain data.
 * With `fragments`, any 8-character piece of a secret counts, since a quoted start of a body
 * carries a piece rather than the whole. Off by default: the Microsoft ids share runs such as
 * `00000000-5e17-4000-8000-`, so a piece of an id quoted on purpose would match its siblings.
 */
export function leakedSecretsIn(
  subject: unknown,
  secrets: readonly string[] = LEAKED_SECRETS,
  { fragments = false } = {},
): string[] {
  const text = stringsIn(subject).join('\n');
  return secrets.filter((secret) =>
    (fragments ? fragmentsOf(secret) : [secret]).some((piece) => text.includes(piece)),
  );
}

let refreshSeq = 0;

export function googleConfig(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
  refreshSeq += 1;
  return {
    provider: 'google',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    // Unique per test: in-flight refreshes are shared per refresh token across instances.
    refreshToken: `refresh-token-${refreshSeq}`,
    ...overrides,
  };
}
