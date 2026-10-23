/**
 * Stand-ins for an OAuth2 token endpoint, stubbed in as the global `fetch`, and the account
 * OAuth2 config the OAuthService suites send to it.
 */

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

const MAX_CAUSE_DEPTH = 10;

/** Every link of an error's cause chain as text, so a secret hidden in a cause is not missed. */
export function errorChainText(error: unknown): string {
  const links: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      links.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      links.push(String(current));
      current = undefined;
    }
  }
  return links.join('\n');
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
