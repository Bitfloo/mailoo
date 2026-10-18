import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fakeTokenEndpoint,
  googleConfig,
  stalledBody,
  stalledTokenEndpoint,
} from '../test-support/token-endpoint.js';
import OAuthService, { TOKEN_REQUEST_TIMEOUT_MS } from './oauth.service.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function tokenResponse(accessToken: string): () => Response {
  return () =>
    new Response(JSON.stringify({ access_token: accessToken, expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
}

afterEach(() => {
  vi.useRealTimers();
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

  it('should refresh each refresh token on its own when two accounts need a token at once', async () => {
    fakeTokenEndpoint(tokenResponse('tok-A'), tokenResponse('tok-B'));
    const service = new OAuthService();
    const tokens = await Promise.all([
      service.getAccessToken(googleConfig()),
      service.getAccessToken(googleConfig()),
    ]);
    expect(tokens).toEqual(['tok-A', 'tok-B']);
  });

  it('should refresh again only after the token it fetched has expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuedAt = new Date('2026-10-01T08:00:00.000Z').getTime();
    vi.setSystemTime(issuedAt);
    const calls = fakeTokenEndpoint(tokenResponse('tok-1'), tokenResponse('tok-2'));
    const service = new OAuthService();
    const oauth2 = googleConfig();

    await service.getAccessToken(oauth2);
    expect(oauth2.tokenExpiry).toBe(issuedAt + 3_600_000);

    vi.setSystemTime(issuedAt + 30 * 60_000);
    expect(await service.getAccessToken(oauth2)).toBe('tok-1');

    // One millisecond short of the five-minute buffer before the one-hour expiry.
    vi.setSystemTime(issuedAt + 55 * 60_000 - 1);
    expect(await service.getAccessToken(oauth2)).toBe('tok-1');
    expect(calls).toHaveLength(1);

    vi.setSystemTime(issuedAt + 55 * 60_000);
    expect(await service.getAccessToken(oauth2)).toBe('tok-2');
    expect(calls).toHaveLength(2);
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

  it('should give up on a token endpoint that stops sending the token', async () => {
    fakeTokenEndpoint(stalledBody(200));
    await expect(new OAuthService().getAccessToken(googleConfig())).rejects.toThrow(
      'OAuth2 token refresh timed out after 15s',
    );
  });

  it('should give up on a token endpoint that stops sending its error', async () => {
    fakeTokenEndpoint(stalledBody(503));
    await expect(new OAuthService().getAccessToken(googleConfig())).rejects.toThrow(
      'OAuth2 token refresh timed out after 15s',
    );
  });

  it('should arm a 15 s timeout on the refresh request', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const calls = fakeTokenEndpoint(tokenResponse('tok-1'));
    await new OAuthService().getAccessToken(googleConfig());
    expect(timeout.mock.calls).toEqual([[15_000]]);
    expect(calls[0].init.signal).toBe(timeout.mock.results[0].value);
  });
});

describe('OAuthService refresh request', () => {
  it.each([
    { provider: 'google', tokenUrl: 'https://oauth2.googleapis.com/token' },
    {
      provider: 'microsoft',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    },
    { provider: 'custom', tokenUrl: 'https://auth.example.com/token' },
  ] as const)(
    'should post a form-encoded refresh to the $provider token URL with the client and refresh token',
    async ({ provider, tokenUrl }) => {
      const calls = fakeTokenEndpoint(tokenResponse('tok-1'));
      const oauth2 = googleConfig({
        provider,
        tokenUrl: 'https://auth.example.com/token',
        authUrl: 'https://auth.example.com/authorize',
      });
      await new OAuthService().getAccessToken(oauth2);
      const [{ url, init }] = calls;
      expect({
        url,
        method: init.method,
        headers: init.headers,
        body: Object.fromEntries(new URLSearchParams(String(init.body))),
      }).toEqual({
        url: tokenUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: {
          grant_type: 'refresh_token',
          client_id: 'client-id',
          client_secret: 'client-secret',
          refresh_token: oauth2.refreshToken,
        },
      });
    },
  );

  it.each([
    { only: 'tokenUrl', endpoints: { tokenUrl: 'https://auth.example.com/token' } },
    { only: 'authUrl', endpoints: { authUrl: 'https://auth.example.com/authorize' } },
  ])('should refuse a custom provider when only its $only is set', async ({ endpoints }) => {
    fakeTokenEndpoint();
    const oauth2 = googleConfig({ provider: 'custom', ...endpoints });
    await expect(new OAuthService().getAccessToken(oauth2)).rejects.toThrow(
      'Custom OAuth2 provider requires tokenUrl and authUrl',
    );
  });
});

describe('README OAuth2 section', () => {
  it('should state the token request timeout the service applies', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    const seconds = TOKEN_REQUEST_TIMEOUT_MS / 1000;
    expect(readme).toContain(
      `give up after ${seconds} seconds, so a provider that stops answering fails the connect with \`OAuth2 token refresh timed out after ${seconds}s\``,
    );
  });
});
