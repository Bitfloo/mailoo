import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fakeTokenEndpoint,
  googleConfig,
  HOSTILE_REFUSAL,
  LEAKED_SECRETS,
  leakedSecretsIn,
  leakyInvalidGrant,
  stalledBody,
  stalledTokenEndpoint,
  valuesBesidesErrorFields,
} from '../test-support/token-endpoint.js';
import type { OAuth2Config } from '../types/index.js';
import OAuthService, {
  TOKEN_ERROR_BODY_MAX_CHARS,
  TOKEN_ERROR_CODE_MAX_CHARS,
  TOKEN_ERROR_DESCRIPTION_MAX_CHARS,
  TOKEN_REQUEST_TIMEOUT_MS,
} from './oauth.service.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function tokenResponse(accessToken: string, expiresIn = 3600): () => Response {
  return () =>
    new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
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
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-10-01T08:00:00.000Z').getTime();
    vi.setSystemTime(now);
    const calls = fakeTokenEndpoint();
    const oauth2 = googleConfig({ accessToken: 'cached', tokenExpiry: now + 3_600_000 });
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

  it('should record the expiry from the lifetime the endpoint sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuedAt = new Date('2026-10-01T08:00:00.000Z').getTime();
    vi.setSystemTime(issuedAt);
    fakeTokenEndpoint(tokenResponse('tok-1', 120));
    const oauth2 = googleConfig();
    await new OAuthService().getAccessToken(oauth2);
    expect(oauth2.tokenExpiry).toBe(issuedAt + 120_000);
  });

  it('should refresh a cached access token when it has no expiry', async () => {
    fakeTokenEndpoint(tokenResponse('tok-1'));
    const oauth2 = googleConfig({ accessToken: 'cached' });
    expect(await new OAuthService().getAccessToken(oauth2)).toBe('tok-1');
  });

  it('should take the token from a 299 answer, the last success status', async () => {
    fakeTokenEndpoint(() =>
      Response.json({ access_token: 'tok-1', expires_in: 3600 }, { status: 299 }),
    );
    expect(await new OAuthService().getAccessToken(googleConfig())).toBe('tok-1');
  });

  it("should name the provider's error code when the refresh is refused", async () => {
    fakeTokenEndpoint(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(new OAuthService().getAccessToken(googleConfig())).rejects.toMatchObject({
      message: 'OAuth2 token refresh failed (400): invalid_grant',
    });
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

  it('should keep the abort as the cause when the refresh times out', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    stalledTokenEndpoint();
    const pending = new OAuthService().getAccessToken(googleConfig());
    const abort = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    controller.abort(abort);
    const error = await pending.catch((err: unknown) => err);
    expect((error as Error).cause).toBe(abort);
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

  it('should refuse an unknown provider', async () => {
    fakeTokenEndpoint();
    // The env loader casts MCP_EMAIL_OAUTH2_PROVIDER unchecked, so any name can arrive here.
    const oauth2 = googleConfig({ provider: 'x' as unknown as OAuth2Config['provider'] });
    await expect(new OAuthService().getAccessToken(oauth2)).rejects.toThrow(
      /Unknown OAuth2 provider: x/,
    );
  });
});

const FLOWS = [
  {
    action: 'token refresh',
    run: async (oauth2 = googleConfig()) => new OAuthService().getAccessToken(oauth2),
  },
  {
    action: 'code exchange',
    run: async (oauth2 = googleConfig()) =>
      OAuthService.exchangeCode(oauth2, 'auth-code', 'http://localhost:3000/cb'),
  },
] as const;

/**
 * A Microsoft identity platform refusal: the AADSTS text, then trace id, correlation id and
 * timestamp on CR LF separated lines (173 characters once the breaks are dropped), then padding
 * that carries one more id past character 200. The same kind of ids also come as top-level fields.
 * Layout from the error response example in the Microsoft identity platform error code reference:
 * https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes
 */
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const TRACE_IN_DESCRIPTION = '00000000-5e17-4000-8000-0000000000a1';
const CORRELATION_IN_DESCRIPTION = '00000000-5e17-4000-8000-0000000000b2';
const TIMESTAMP = '2026-10-23 07:00:00Z';
const REFERENCE_IN_PADDING = '00000000-5e17-4000-8000-0000000000e5';
const TRACE_FIELD = '00000000-5e17-4000-8000-0000000000c3';
const CORRELATION_FIELD = '00000000-5e17-4000-8000-0000000000d4';
const MICROSOFT_IDS_BEYOND_THE_CUT = [REFERENCE_IN_PADDING, TRACE_FIELD, CORRELATION_FIELD];
const MICROSOFT_REFUSAL = {
  error: 'invalid_grant',
  error_description: [
    'AADSTS70000: The provided grant has expired.',
    `Trace ID: ${TRACE_IN_DESCRIPTION}`,
    `Correlation ID: ${CORRELATION_IN_DESCRIPTION}`,
    `Timestamp: ${TIMESTAMP} Send a new interactive authorization request for this user and resource. Reference ID: ${REFERENCE_IN_PADDING}`,
  ].join('\r\n'),
  error_codes: [70_000],
  trace_id: TRACE_FIELD,
  correlation_id: CORRELATION_FIELD,
};
/** The description with CR LF dropped, cut after 200 characters (inside "authorization"). */
const MICROSOFT_DESCRIPTION_CUT =
  `AADSTS70000: The provided grant has expired.Trace ID: ${TRACE_IN_DESCRIPTION}` +
  `Correlation ID: ${CORRELATION_IN_DESCRIPTION}Timestamp: ${TIMESTAMP} Send a new interactive aut`;

/** Characters the RFC 6749 §5.2 error fields may carry, kept; every other character is dropped. */
const CLEANING_CASES = [
  {
    name: 'a newline that would forge a log line',
    raw: 'expired.\r\nlevel=error',
    kept: 'expired.level=error',
  },
  { name: 'tabs and the bell', raw: 'bell\u0007 tab\there', kept: 'bell tabhere' },
  { name: 'escape and DEL controls', raw: 'red\u001B[31m\u007F done', kept: 'red[31m done' },
  { name: 'quotes and backslashes', raw: 'say "hi" \\ bye', kept: 'say hi  bye' },
  { name: 'accented letters and emoji', raw: 'naïve \u{1F4A5} done', kept: 'nave  done' },
  {
    name: 'NUL, vertical tab, form feed and the C1 controls',
    raw: 'a\u0000b\u000B\u000C\u000E\u001A\u0080\u0085\u009B\u009Fc',
    kept: 'abc',
  },
  {
    name: 'every boundary of the allowed ranges',
    raw: 'a\u001F b!"#[\\]~\u007F',
    kept: 'a b!#[]~',
  },
] as const;

async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  const error = await run().then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(error instanceof Error)) throw new Error('expected the call to reject');
  return error;
}

function refusedWith(status: number, body: string): void {
  fakeTokenEndpoint(() => new Response(body, { status }));
}

/** An `invalid_grant` refusal padded to exactly `size` characters. */
function refusalOfLength(size: number): string {
  const shell = JSON.stringify({ error: 'invalid_grant', padding: '' });
  return JSON.stringify({ error: 'invalid_grant', padding: 'x'.repeat(size - shell.length) });
}

describe('OAuthService token error limits', () => {
  it('should cap the error code at 64 characters', () => {
    expect(TOKEN_ERROR_CODE_MAX_CHARS).toBe(64);
  });

  it('should cap the error description at 200 characters', () => {
    expect(TOKEN_ERROR_DESCRIPTION_MAX_CHARS).toBe(200);
  });

  it('should parse no body longer than 4096 characters', () => {
    expect(TOKEN_ERROR_BODY_MAX_CHARS).toBe(4096);
  });
});

describe.each(FLOWS)('OAuthService $action when the token endpoint refuses', ({ action, run }) => {
  const failed = `OAuth2 ${action} failed`;

  it('should name only the error and its description when the body also echoes tokens', async () => {
    fakeTokenEndpoint(leakyInvalidGrant(400));
    const error = await failureOf(run);
    expect({ message: error.message, leaked: leakedSecretsIn(error) }).toEqual({
      message: `${failed} (400): invalid_grant: Token has been expired or revoked.`,
      leaked: [],
    });
  });

  it('should carry no cause that could hold the response body', async () => {
    fakeTokenEndpoint(leakyInvalidGrant(400));
    expect((await failureOf(run)).cause).toBeUndefined();
  });

  it('should cut an over-long error code at the code limit', async () => {
    const tooLong = 'a'.repeat(TOKEN_ERROR_CODE_MAX_CHARS + 30);
    refusedWith(400, JSON.stringify({ error: tooLong }));
    expect((await failureOf(run)).message).toBe(
      `${failed} (400): ${'a'.repeat(TOKEN_ERROR_CODE_MAX_CHARS)}`,
    );
  });

  it('should keep exactly 64 characters of a 94-character error code', async () => {
    refusedWith(400, JSON.stringify({ error: 'a'.repeat(94) }));
    const { message } = await failureOf(run);
    const tail = message.slice(`${failed} (400): `.length);
    expect({ message, tailLength: tail.length }).toEqual({
      message: `${failed} (400): ${'a'.repeat(64)}`,
      tailLength: 64,
    });
  });

  it('should cut an over-long description at the description limit', async () => {
    const tooLong = 'b'.repeat(TOKEN_ERROR_DESCRIPTION_MAX_CHARS + 30);
    refusedWith(400, JSON.stringify({ error: 'invalid_grant', error_description: tooLong }));
    expect((await failureOf(run)).message).toBe(
      `${failed} (400): invalid_grant: ${'b'.repeat(TOKEN_ERROR_DESCRIPTION_MAX_CHARS)}`,
    );
  });

  it('should keep an error code that is exactly at the limit whole', async () => {
    const exact = 'c'.repeat(TOKEN_ERROR_CODE_MAX_CHARS);
    refusedWith(400, JSON.stringify({ error: exact }));
    expect((await failureOf(run)).message).toBe(`${failed} (400): ${exact}`);
  });

  it('should keep a description that is exactly at the limit whole', async () => {
    const exact = 'd'.repeat(TOKEN_ERROR_DESCRIPTION_MAX_CHARS);
    refusedWith(400, JSON.stringify({ error: 'invalid_grant', error_description: exact }));
    expect((await failureOf(run)).message).toBe(`${failed} (400): invalid_grant: ${exact}`);
  });

  it.each(CLEANING_CASES)('should drop $name from the error code', async ({ raw, kept }) => {
    refusedWith(400, JSON.stringify({ error: raw }));
    expect((await failureOf(run)).message).toBe(`${failed} (400): ${kept}`);
  });

  it.each(CLEANING_CASES)('should drop $name from the description', async ({ raw, kept }) => {
    refusedWith(400, JSON.stringify({ error: 'invalid_grant', error_description: raw }));
    expect((await failureOf(run)).message).toBe(`${failed} (400): invalid_grant: ${kept}`);
  });

  it('should count the limit after the dropped characters, not before', async () => {
    const noisy = 'e\n'.repeat(TOKEN_ERROR_CODE_MAX_CHARS + 10);
    refusedWith(400, JSON.stringify({ error: noisy }));
    expect((await failureOf(run)).message).toBe(
      `${failed} (400): ${'e'.repeat(TOKEN_ERROR_CODE_MAX_CHARS)}`,
    );
  });

  it('should trim the spaces a cut or a dropped character leaves at the ends', async () => {
    refusedWith(400, JSON.stringify({ error: ' \n padded \n ' }));
    expect((await failureOf(run)).message).toBe(`${failed} (400): padded`);
  });

  it('should trim the space the code limit leaves at the end of the error code', async () => {
    const kept = 'a'.repeat(TOKEN_ERROR_CODE_MAX_CHARS - 1);
    refusedWith(400, JSON.stringify({ error: `${kept} b` }));
    expect((await failureOf(run)).message).toBe(`${failed} (400): ${kept}`);
  });

  it('should trim the space the description limit leaves at the end of the description', async () => {
    const kept = 'd'.repeat(TOKEN_ERROR_DESCRIPTION_MAX_CHARS - 1);
    refusedWith(400, JSON.stringify({ error: 'invalid_grant', error_description: `${kept} x` }));
    expect((await failureOf(run)).message).toBe(`${failed} (400): invalid_grant: ${kept}`);
  });

  it('should name only the error and its description when the body carries other fields', async () => {
    refusedWith(400, JSON.stringify(HOSTILE_REFUSAL));
    const error = await failureOf(run);
    expect({
      message: error.message,
      leaked: leakedSecretsIn(error, valuesBesidesErrorFields(HOSTILE_REFUSAL)),
    }).toEqual({
      message: `${failed} (400): invalid_grant: Token has been expired or revoked.`,
      leaked: [],
    });
  });

  it.each([
    { missing: 'error_description', named: ': invalid_grant' },
    { missing: 'error', named: '' },
  ] as const)(
    'should not fill in a missing $missing from the other fields',
    async ({ missing, named }) => {
      const body = Object.fromEntries(
        Object.entries(HOSTILE_REFUSAL).filter(([field]) => field !== missing),
      );
      refusedWith(400, JSON.stringify(body));
      const error = await failureOf(run);
      expect({
        message: error.message,
        leaked: leakedSecretsIn(error, valuesBesidesErrorFields(body)),
      }).toEqual({ message: `${failed} (400)${named}`, leaked: [] });
    },
  );

  it('should drop the line breaks of a Microsoft refusal and cut it before the ids past the limit', async () => {
    const calls = fakeTokenEndpoint(() => Response.json(MICROSOFT_REFUSAL, { status: 400 }));
    const error = await failureOf(async () => run(googleConfig({ provider: 'microsoft' })));
    expect({
      cutLength: MICROSOFT_DESCRIPTION_CUT.length,
      tokenUrls: calls.map((call) => call.url),
      message: error.message,
      leaked: leakedSecretsIn(error, MICROSOFT_IDS_BEYOND_THE_CUT),
    }).toEqual({
      cutLength: TOKEN_ERROR_DESCRIPTION_MAX_CHARS,
      tokenUrls: [MICROSOFT_TOKEN_URL],
      message: `${failed} (400): invalid_grant: ${MICROSOFT_DESCRIPTION_CUT}`,
      leaked: [],
    });
  });

  it.each([
    { name: 'an empty error code', body: { error: '' } },
    { name: 'an error code made only of spaces', body: { error: '   ' } },
    { name: 'an error code with nothing allowed in it', body: { error: '\u{1F4A5}\n"\\' } },
    {
      name: 'a description next to an unusable error code',
      body: { error: '\n', error_description: 'Token has been expired or revoked.' },
    },
  ])('should name no error when the body holds $name', async ({ body }) => {
    refusedWith(400, JSON.stringify(body));
    expect((await failureOf(run)).message).toBe(`${failed} (400)`);
  });

  it.each([
    { name: 'empty', description: '' },
    { name: 'made only of dropped characters', description: '\n\u{1F4A5}' },
    { name: 'a number', description: 42 },
    { name: 'an object', description: { text: LEAKED_SECRETS[0] } },
    { name: 'an array', description: [LEAKED_SECRETS[0]] },
    { name: 'null', description: null },
  ])('should leave the description out when it is $name', async ({ description }) => {
    refusedWith(400, JSON.stringify({ error: 'invalid_grant', error_description: description }));
    const error = await failureOf(run);
    expect({ message: error.message, leaked: leakedSecretsIn(error) }).toEqual({
      message: `${failed} (400): invalid_grant`,
      leaked: [],
    });
  });

  it.each([
    { name: 'HTML', body: `<html><body>${LEAKED_SECRETS[0]}</body></html>` },
    { name: 'a form-encoded body', body: `access_token=${LEAKED_SECRETS[0]}&expires_in=3600` },
    { name: 'plain text', body: `proxy said: ${LEAKED_SECRETS[1]}` },
    {
      name: 'plain text that starts with a token',
      body: `${LEAKED_SECRETS[0]} rejected: upstream unavailable`,
    },
    { name: 'an empty body', body: '' },
  ])('should name no body when a 503 answers with $name', async ({ body }) => {
    refusedWith(503, body);
    const error = await failureOf(run);
    expect({
      message: error.message,
      leaked: leakedSecretsIn(error, LEAKED_SECRETS, { fragments: true }),
    }).toEqual({
      message: `${failed} (503)`,
      leaked: [],
    });
  });

  it.each([
    { name: 'no error field', body: { access_token: LEAKED_SECRETS[0] } },
    { name: 'a numeric error field', body: { error: 401, access_token: LEAKED_SECRETS[0] } },
    {
      name: 'an object error field',
      body: { error: { code: LEAKED_SECRETS[1], message: LEAKED_SECRETS[0] } },
    },
    { name: 'an array error field', body: { error: [LEAKED_SECRETS[2]] } },
    { name: 'a null error field', body: { error: null, refresh_token: LEAKED_SECRETS[1] } },
    { name: 'a JSON array', body: [LEAKED_SECRETS[0]] },
    { name: 'a JSON string', body: LEAKED_SECRETS[0] },
    { name: 'JSON null', body: null },
  ])('should name no body when a 401 answers JSON with $name', async ({ body }) => {
    refusedWith(401, JSON.stringify(body));
    const error = await failureOf(run);
    expect({ message: error.message, leaked: leakedSecretsIn(error) }).toEqual({
      message: `${failed} (401)`,
      leaked: [],
    });
  });

  // fetch follows a redirect only when it names a Location, so a 3xx without one is the answer.
  it.each([{ status: 300 }, { status: 302 }, { status: 399 }])(
    'should refuse a $status answer even when its body carries tokens',
    async ({ status }) => {
      refusedWith(status, JSON.stringify({ access_token: LEAKED_SECRETS[0], expires_in: 3600 }));
      const error = await failureOf(run);
      expect({ message: error.message, leaked: leakedSecretsIn(error) }).toEqual({
        message: `${failed} (${status})`,
        leaked: [],
      });
    },
  );

  it('should still name the error when the body is exactly as large as the parse limit', async () => {
    const shell = JSON.stringify({ error: 'invalid_grant', padding: '' });
    const padding = 'x'.repeat(TOKEN_ERROR_BODY_MAX_CHARS - shell.length);
    const body = JSON.stringify({ error: 'invalid_grant', padding });
    refusedWith(400, body);
    expect({ size: body.length, message: (await failureOf(run)).message }).toEqual({
      size: TOKEN_ERROR_BODY_MAX_CHARS,
      message: `${failed} (400): invalid_grant`,
    });
  });

  it('should count the parse limit in characters, not in UTF-8 bytes', async () => {
    const shell = JSON.stringify({ error: 'invalid_grant', padding: '' });
    const padding = 'é'.repeat(TOKEN_ERROR_BODY_MAX_CHARS - shell.length);
    const body = JSON.stringify({ error: 'invalid_grant', padding });
    refusedWith(400, body);
    expect({
      characters: body.length,
      overInBytes: Buffer.byteLength(body) > TOKEN_ERROR_BODY_MAX_CHARS,
      message: (await failureOf(run)).message,
    }).toEqual({
      characters: TOKEN_ERROR_BODY_MAX_CHARS,
      overInBytes: true,
      message: `${failed} (400): invalid_grant`,
    });
  });

  it('should name no body when it is one character over the parse limit', async () => {
    const shell = JSON.stringify({ error: 'invalid_grant', padding: '' });
    const padding = 'x'.repeat(TOKEN_ERROR_BODY_MAX_CHARS - shell.length + 1);
    const body = JSON.stringify({ error: 'invalid_grant', padding });
    refusedWith(400, body);
    expect({ size: body.length, message: (await failureOf(run)).message }).toEqual({
      size: TOKEN_ERROR_BODY_MAX_CHARS + 1,
      message: `${failed} (400)`,
    });
  });

  it('should still name the error in a body of 4096 characters', async () => {
    const body = refusalOfLength(4096);
    refusedWith(400, body);
    expect({ size: body.length, message: (await failureOf(run)).message }).toEqual({
      size: 4096,
      message: `${failed} (400): invalid_grant`,
    });
  });

  it('should name no body of 4097 characters', async () => {
    const body = refusalOfLength(4097);
    refusedWith(400, body);
    expect({ size: body.length, message: (await failureOf(run)).message }).toEqual({
      size: 4097,
      message: `${failed} (400)`,
    });
  });

  it('should not parse a body of 4097 characters at all', async () => {
    const body = refusalOfLength(4097);
    refusedWith(400, body);
    const parse = vi.spyOn(JSON, 'parse');
    const { message } = await failureOf(run);
    const parsedTheBody = parse.mock.calls.some(([text]) => text === body);
    parse.mockRestore();
    expect({ message, parsedTheBody }).toEqual({
      message: `${failed} (400)`,
      parsedTheBody: false,
    });
  });
});

describe.each(FLOWS)('OAuthService $action when a 200 answer is not JSON', ({ action, run }) => {
  it.each([
    { name: 'a form-encoded body', body: `access_token=${LEAKED_SECRETS[0]}&expires_in=3600` },
    { name: 'HTML', body: `<html>${LEAKED_SECRETS[1]}</html>` },
    { name: 'truncated JSON', body: `{"access_token":"${LEAKED_SECRETS[2]}","expires_in":` },
    { name: 'a bare token in plain text', body: `${LEAKED_SECRETS[0]} 3600` },
    { name: 'an empty body', body: '' },
  ])('should reject without the body or a parse error when it is $name', async ({ body }) => {
    fakeTokenEndpoint(() => new Response(body, { status: 200 }));
    const error = await failureOf(run);
    expect({
      message: error.message,
      cause: error.cause,
      leaked: leakedSecretsIn(error, LEAKED_SECRETS, { fragments: true }),
    }).toEqual({
      message: `OAuth2 ${action} failed: the token endpoint did not return JSON`,
      cause: undefined,
      leaked: [],
    });
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
