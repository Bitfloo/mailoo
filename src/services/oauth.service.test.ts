import type { OAuth2Config } from '../types/index.js';
import OAuthService from './oauth.service.js';

/** Token endpoint stand-in: answers each POST with the next scripted response. */
function fakeTokenEndpoint(...responses: (() => Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected token request');
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function tokenResponse(accessToken: string): () => Response {
  return () =>
    new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

/** A fetch that never answers until its signal aborts, like a stalled token endpoint. */
function stalledTokenEndpoint() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason);
          });
        }),
    ),
  );
}

let refreshSeq = 0;

function googleConfig(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OAuthService.getAccessToken', () => {
  it('should return the cached token without a request while it is still valid', async () => {
    const calls = fakeTokenEndpoint();
    const oauth2 = googleConfig({ accessToken: 'cached', tokenExpiry: Date.now() + 3_600_000 });
    expect(await new OAuthService().getAccessToken(oauth2)).toBe('cached');
    expect(calls).toHaveLength(0);
  });

  it('should send one refresh request when five callers need a token at once', async () => {
    const calls = fakeTokenEndpoint(tokenResponse('tok-1'), tokenResponse('tok-2'));
    const service = new OAuthService();
    const oauth2 = googleConfig();
    const tokens = await Promise.all(
      Array.from({ length: 5 }, async () => service.getAccessToken(oauth2)),
    );
    expect(calls).toHaveLength(1);
    expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1', 'tok-1', 'tok-1']);
  });

  it('should share one refresh between two service instances holding the same refresh token', async () => {
    const calls = fakeTokenEndpoint(tokenResponse('tok-1'), tokenResponse('tok-2'));
    const shared = googleConfig();
    const watcherCopy = { ...shared };
    const tokens = await Promise.all([
      new OAuthService().getAccessToken(shared),
      new OAuthService().getAccessToken(watcherCopy),
    ]);
    expect(calls).toHaveLength(1);
    expect(tokens).toEqual(['tok-1', 'tok-1']);
    expect(watcherCopy.accessToken).toBe('tok-1');
  });

  it('should try again after a failed refresh instead of replaying the failure', async () => {
    const calls = fakeTokenEndpoint(
      () => new Response('temporarily unavailable', { status: 503 }),
      tokenResponse('tok-2'),
    );
    const service = new OAuthService();
    const oauth2 = googleConfig();
    await expect(service.getAccessToken(oauth2)).rejects.toThrow('(503)');
    expect(await service.getAccessToken(oauth2)).toBe('tok-2');
    expect(calls).toHaveLength(2);
  });

  it('should give up on a token endpoint that does not answer', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    stalledTokenEndpoint();
    const pending = new OAuthService().getAccessToken(googleConfig());
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await expect(pending).rejects.toThrow('OAuth2 token refresh timed out after 15s');
  });

  it('should arm a 15 s timeout on the refresh request', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const calls = fakeTokenEndpoint(tokenResponse('tok-1'));
    await new OAuthService().getAccessToken(googleConfig());
    expect(timeout.mock.calls).toEqual([[15_000]]);
    expect(calls[0].init.signal).toBe(timeout.mock.results[0].value);
  });
});

describe('OAuthService.exchangeCode', () => {
  it('should give up on a token endpoint that does not answer', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    stalledTokenEndpoint();
    const pending = OAuthService.exchangeCode(
      googleConfig(),
      'auth-code',
      'http://localhost:3000/cb',
    );
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await expect(pending).rejects.toThrow('OAuth2 code exchange timed out after 15s');
  });

  it('should arm a 15 s timeout on the code exchange request', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const calls = fakeTokenEndpoint(() =>
      Response.json({ access_token: 'tok', refresh_token: 'refresh', expires_in: 3600 }),
    );
    await OAuthService.exchangeCode(googleConfig(), 'auth-code', 'http://localhost:3000/cb');
    expect(timeout.mock.calls).toEqual([[15_000]]);
    expect(calls[0].init.signal).toBe(timeout.mock.results[0].value);
  });
});
