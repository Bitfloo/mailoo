import {
  fakeTokenEndpoint,
  googleConfig,
  stalledBody,
  stalledTokenEndpoint,
} from '../test-support/token-endpoint.js';
import OAuthService from './oauth.service.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('should give up on a token endpoint that stops sending the tokens', async () => {
    fakeTokenEndpoint(stalledBody(200));
    await expect(
      OAuthService.exchangeCode(googleConfig(), 'auth-code', 'http://localhost:3000/cb'),
    ).rejects.toThrow('OAuth2 code exchange timed out after 15s');
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

  it('should post the authorization code and redirect URI form-encoded to the token URL', async () => {
    const calls = fakeTokenEndpoint(() =>
      Response.json({ access_token: 'tok', refresh_token: 'refresh', expires_in: 3600 }),
    );
    await OAuthService.exchangeCode(googleConfig(), 'auth-code', 'http://localhost:3000/cb');
    const [{ url, init }] = calls;
    expect({
      url,
      method: init.method,
      headers: init.headers,
      body: Object.fromEntries(new URLSearchParams(String(init.body))),
    }).toEqual({
      url: 'https://oauth2.googleapis.com/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: {
        grant_type: 'authorization_code',
        client_id: 'client-id',
        client_secret: 'client-secret',
        code: 'auth-code',
        redirect_uri: 'http://localhost:3000/cb',
      },
    });
  });

  it('should return the access token, refresh token and lifetime the endpoint sent', async () => {
    fakeTokenEndpoint(() =>
      Response.json({ access_token: 'tok', refresh_token: 'refresh', expires_in: 3600 }),
    );
    await expect(
      OAuthService.exchangeCode(googleConfig(), 'auth-code', 'http://localhost:3000/cb'),
    ).resolves.toEqual({ accessToken: 'tok', refreshToken: 'refresh', expiresIn: 3600 });
  });
});

describe('OAuthService.generateAuthUrl', () => {
  it.each([
    {
      provider: 'google',
      endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      scope: 'https://mail.google.com/',
    },
    {
      provider: 'microsoft',
      endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      scope:
        'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access',
    },
  ] as const)(
    'should ask the $provider consent page for offline access to the mail scopes',
    ({ provider, endpoint, scope }) => {
      const url = new URL(
        OAuthService.generateAuthUrl(googleConfig({ provider }), 'http://localhost:3000/cb'),
      );
      expect({
        endpoint: `${url.origin}${url.pathname}`,
        query: Object.fromEntries(url.searchParams),
      }).toEqual({
        endpoint,
        query: {
          client_id: 'client-id',
          redirect_uri: 'http://localhost:3000/cb',
          response_type: 'code',
          scope,
          access_type: 'offline',
          prompt: 'consent',
        },
      });
    },
  );
});
