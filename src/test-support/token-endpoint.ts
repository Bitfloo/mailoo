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
