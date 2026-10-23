/**
 * Stand-ins for an OAuth2 token endpoint, stubbed in as the global `fetch`, and the account
 * OAuth2 config the OAuthService suites send to it.
 */

import { inspect } from 'node:util';

import type { OAuth2Config } from '../types/index.js';

interface TokenRequest {
  url: string;
  init: RequestInit;
}

/** Token endpoint stand-in: answers each POST with the next scripted response. */
export function fakeTokenEndpoint(...responses: (() => Response)[]): TokenRequest[] {
  const calls: TokenRequest[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected token request');
    return next();
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

/**
 * An RFC 6749 §5.2 error body with a fake secret in every field a message must not quote,
 * the vendor extras included. Only `error` and `error_description` may reach an error.
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

/** Bounds both the cause chain followed and the nesting searched for bytes. */
const MAX_DEPTH = 10;

/** No cut-off: `inspect` hides array items past 100 and string characters past 10000 by default. */
const INSPECT_IN_FULL = { depth: null, maxArrayLength: null, maxStringLength: null } as const;

/** Bytes anywhere in the own properties of a value, as UTF-8: `inspect` prints them as hex and stops after 50. */
function bytesInside(value: unknown, depth = 0): string[] {
  if (value instanceof ArrayBuffer) return [Buffer.from(value).toString('utf8')];
  if (ArrayBuffer.isView(value)) {
    return [Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')];
  }
  if (typeof value !== 'object' || value === null || depth >= MAX_DEPTH) return [];
  return Object.getOwnPropertyNames(value).flatMap((name) =>
    bytesInside(Object.getOwnPropertyDescriptor(value, name)?.value, depth + 1),
  );
}

/**
 * Every link of an error's cause chain as text: the full `inspect` dump and the bytes its
 * properties hold as UTF-8 for any value, and for an error also its message and every own
 * property, non-enumerable ones too, as JSON. Strings inside a non-enumerable property that holds
 * an object are the one place none of them looks.
 */
function errorChainText(error: unknown): string {
  const texts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined; depth += 1) {
    texts.push(inspect(current, INSPECT_IN_FULL), ...bytesInside(current));
    if (current instanceof Error) {
      texts.push(
        `${current.name}: ${current.message}`,
        JSON.stringify(current, Object.getOwnPropertyNames(current)),
      );
      current = current.cause;
    } else {
      current = undefined;
    }
  }
  return texts.join('\n');
}

/** The secrets found anywhere in an error, its cause chain and their properties, or in plain data. */
export function leakedSecretsIn(
  subject: unknown,
  secrets: readonly string[] = LEAKED_SECRETS,
): string[] {
  const text = errorChainText(subject);
  return secrets.filter((secret) => text.includes(secret));
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
