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
});
