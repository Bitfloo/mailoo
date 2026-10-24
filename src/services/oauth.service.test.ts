import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  echoingRefusal,
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
  SECRET_SHAPE_MIN_CHARS,
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

/**
 * The values HOSTILE_REFUSAL holds outside `error` and `error_description`, written out rather
 * than read from it: a field deleted from the fixture must fail the pin, not shrink the check.
 */
const HOSTILE_VALUES = [
  'https://auth.example.test/errors/SENTINEL-URI-0004',
  '90412873',
  'SENTINEL-TRACE-0005',
  'SENTINEL-CORRELATION-0006',
  'SENTINEL-MESSAGE-0007',
  'SENTINEL-DETAIL-0008',
  'SENTINEL-REASON-0009',
  'SENTINEL-NESTED-0010',
  'SENTINEL-ACCESS-0001',
  'SENTINEL-REFRESH-0002',
  'SENTINEL-ID-0003',
];

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
  it('should export 64 as the error code cap', () => {
    expect(TOKEN_ERROR_CODE_MAX_CHARS).toBe(64);
  });

  it('should export 200 as the error description cap', () => {
    expect(TOKEN_ERROR_DESCRIPTION_MAX_CHARS).toBe(200);
  });

  it('should export 4096 as the body parse limit', () => {
    expect(TOKEN_ERROR_BODY_MAX_CHARS).toBe(4096);
  });

  it('should export 8 as the shortest secret shape it cuts out of a field', () => {
    expect(SECRET_SHAPE_MIN_CHARS).toBe(8);
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
      sentByEndpoint: valuesBesidesErrorFields(HOSTILE_REFUSAL),
      message: error.message,
      leaked: leakedSecretsIn(error, HOSTILE_VALUES),
    }).toEqual({
      sentByEndpoint: HOSTILE_VALUES,
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
        sentByEndpoint: valuesBesidesErrorFields(body),
        message: error.message,
        leaked: leakedSecretsIn(error, HOSTILE_VALUES),
      }).toEqual({
        sentByEndpoint: HOSTILE_VALUES,
        message: `${failed} (400)${named}`,
        leaked: [],
      });
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

  it('should name no error from a body past the parse limit whose first 4096 characters are a valid refusal', async () => {
    const body =
      JSON.stringify({ error: 'invalid_grant' }) + ' '.repeat(TOKEN_ERROR_BODY_MAX_CHARS);
    refusedWith(400, body);
    expect({
      overTheLimit: body.length > TOKEN_ERROR_BODY_MAX_CHARS,
      parsed: JSON.parse(body) as unknown,
      prefixParsed: JSON.parse(body.slice(0, TOKEN_ERROR_BODY_MAX_CHARS)) as unknown,
      message: (await failureOf(run)).message,
    }).toEqual({
      overTheLimit: true,
      parsed: { error: 'invalid_grant' },
      prefixParsed: { error: 'invalid_grant' },
      message: `${failed} (400)`,
    });
  });
});

interface SentSecrets {
  client: string;
  grant: string;
  /** The other shapes an echo can give them: form- or URL-encoded, or with dropped characters gone. */
  reshaped: string[];
}

/** Characters both error fields keep, so only redaction can take these out. */
const PLAIN: SentSecrets = {
  client: 'GOCSPX-q7Lw2Rt9Vk4Zp',
  grant: '1//04Hs8Jd3Fq6YbN0cVe',
  reshaped: ['1%2F%2F04Hs8Jd3Fq6YbN0cVe'],
};

/** A quote, a backslash and a non-ASCII letter: the error charset drops all three. */
const QUOTED: SentSecrets = {
  client: 'GOCSPX-q7"Lw2\\Rt9Vk4',
  grant: '1//04Hsé8Jd3Fq6Yb"N0',
  reshaped: [
    'GOCSPX-q7Lw2Rt9Vk4',
    '1//04Hs8Jd3Fq6YbN0',
    'GOCSPX-q7%22Lw2%5CRt9Vk4',
    '1%2F%2F04Hs%C3%A98Jd3Fq6Yb%22N0',
  ],
};

/** A form body encodes `~ ! ( )` and a URL component keeps them, so the two echoes differ. */
const PERCENT: SentSecrets = {
  client: 'GOCSPX-c5/Tq+Wz~8d=Rk!',
  grant: '1//04rT+u~Lp=Ek(4)Vb',
  reshaped: [
    'GOCSPX-c5%2FTq%2BWz%7E8d%3DRk%21',
    'GOCSPX-c5%2FTq%2BWz~8d%3DRk!',
    '1%2F%2F04rT%2Bu%7ELp%3DEk%284%29Vb',
    '1%2F%2F04rT%2Bu~Lp%3DEk(4)Vb',
  ],
};

/** The client secret starts the grant: replaced first, it would leave the grant's tail behind. */
const NESTED: SentSecrets = {
  client: 'GOCSPX-q7Lw2Rt9',
  grant: 'GOCSPX-q7Lw2Rt9Vk4Zp8Jd3Fq6Yb',
  reshaped: [],
};

/**
 * Nothing the error charset keeps: only redaction before the filter can mark where it stood. Eight
 * characters, so the secret as given is long enough to be cut out rather than drop the field.
 */
const DROPPED_ONLY: SentSecrets = {
  client: 'ÿéßüöäñç',
  grant: '1//04Hs8Jd3Fq6YbN0cVe',
  reshaped: ['%C3%BF%C3%A9%C3%9F%C3%BC%C3%B6%C3%A4%C3%B1%C3%A7', '1%2F%2F04Hs8Jd3Fq6YbN0cVe'],
};

/**
 * A lone surrogate in the configured client secret. The form sends it as U+FFFD, so that is what
 * an endpoint can echo; the raw secret would make encodeURIComponent throw a URIError.
 */
const LONE_SURROGATE: SentSecrets = {
  client: 'GOCSPX-a1b2c3d4\uD83Dz9y8x7w6v5',
  grant: '1//04Hs8Jd3Fq6YbN0cVe',
  reshaped: [
    'GOCSPX-a1b2c3d4�z9y8x7w6v5',
    'GOCSPX-a1b2c3d4z9y8x7w6v5',
    'GOCSPX-a1b2c3d4%EF%BF%BDz9y8x7w6v5',
  ],
};

/**
 * Every regex syntax character, a trailing backslash and an unmatched `)` among them. Built into a
 * pattern unescaped they match something else, or throw an error that quotes the secret.
 */
const REGEX_SYNTAX: SentSecrets = {
  client: 'GOCSPX-a^b$c.d*e+f?g(h)i[j]k{2}m|n\\',
  grant: '1//0)p(q]r[s}t{u',
  reshaped: [
    'GOCSPX-a^b$c.d*e+f?g(h)i[j]k{2}m|n',
    'GOCSPX-a%5Eb%24c.d*e%2Bf%3Fg%28h%29i%5Bj%5Dk%7B2%7Dm%7Cn%5C',
    'GOCSPX-a%5Eb%24c.d*e%2Bf%3Fg(h)i%5Bj%5Dk%7B2%7Dm%7Cn%5C',
    '1%2F%2F0%29p%28q%5Dr%5Bs%7Dt%7Bu',
    '1%2F%2F0)p(q%5Dr%5Bs%7Dt%7Bu',
  ],
};

/**
 * Each hex letter A to F stands in some escape, and an echo can write it in either case: `%2F`
 * `%2B` `%7E` `%3D`, `%C3%BF` for `ÿ`, `%C3%A9` for `é`. A form body escapes `~`, a URL keeps it.
 */
const CASED_ESCAPES: SentSecrets = {
  client: 'GOCSPX-sec/ret+1~=ÿé',
  grant: '1//0gAb+c/De~ÿ',
  reshaped: [
    'GOCSPX-sec/ret+1~=',
    'GOCSPX-sec%2Fret%2B1%7E%3D%C3%BF%C3%A9',
    'GOCSPX-sec%2Fret%2B1~%3D%C3%BF%C3%A9',
    'GOCSPX-sec%2fret%2b1%7e%3d%c3%bf%c3%a9',
    'GOCSPX-sec%2fret%2b1~%3d%c3%bf%c3%a9',
    'GOCSPX-sec%2fret%2b1%7e%3d%C3%Bf%C3%A9',
    'GOCSPX-sec%2fret%2b1~%3d%C3%Bf%C3%A9',
    '1//0gAb+c/De~',
    '1%2F%2F0gAb%2Bc%2FDe%7E%C3%BF',
    '1%2F%2F0gAb%2Bc%2FDe~%C3%BF',
    '1%2f%2f0gAb%2bc%2fDe%7e%c3%bf',
    '1%2f%2f0gAb%2bc%2fDe~%c3%bf',
    '1%2f%2f0gAb%2bc%2fDe%7e%C3%Bf',
    '1%2f%2f0gAb%2bc%2fDe~%C3%Bf',
  ],
};

/**
 * The client secret ends where the grant starts: replacing either one first leaves a piece of
 * the other.
 */
const OVERLAPPING: SentSecrets = {
  client: 'ABCDEFGHIJKLMNOPQ',
  grant: 'JKLMNOPQRSTUVWXY',
  reshaped: [],
};

/** The client secret sits inside the grant, away from both ends: the grant's cut keeps its end. */
const CONTAINED: SentSecrets = {
  client: '8Jd3Fq6Y',
  grant: '1//04Hs8Jd3Fq6YbN0cVe',
  reshaped: ['1%2F%2F04Hs8Jd3Fq6YbN0cVe'],
};

/** The client secret ends with its own start, so two echoes of it can share those characters. */
const SELF_OVERLAPPING: SentSecrets = {
  client: 'GOCSPX-q7Lw-GOCSPX',
  grant: '1//04Hs8Jd3Fq6YbN0cVe',
  reshaped: [],
};

/**
 * The grant sits inside the client secret. An echo broken by a dropped character holds the grant
 * as given and the client secret only once the character is gone. Sent without a fresh grant:
 * a suffix would take the grant out of the client secret.
 */
const GRANT_INSIDE_CLIENT: SentSecrets = {
  client: 'ABCDEFGHIJKLMNOPQRSTUVWX',
  grant: 'IJKLMNOP',
  reshaped: [],
};

/** The same nesting the other way round, so the grant can take a fresh suffix. */
const CLIENT_INSIDE_GRANT: SentSecrets = {
  client: 'IJKLMNOP',
  grant: 'ABCDEFGHIJKLMNOPQRSTUVWX',
  reshaped: [],
};

/** The text either side of a redacted grant, joined by the marker, spells the client secret. */
const AROUND_A_MARKER: SentSecrets = {
  client: 'AA[redacted]ZZ',
  grant: 'INNER-SECRET',
  reshaped: [],
};

function lowercaseEscapes(encoded: string): string {
  return encoded.replace(/%[0-9A-F]{2}/g, (escaped) => escaped.toLowerCase());
}

/** The second hex digit lowercased: `%2f` beside `%C3`, and `%Bf` mixes case inside one escape. */
function mixedCaseEscapes(encoded: string): string {
  return encoded.replace(
    /(%[0-9A-F])([0-9A-F])/g,
    (_, head: string, low: string) => `${head}${low.toLowerCase()}`,
  );
}

function swapCase(text: string): string {
  return text.replace(/[a-z]/gi, (letter) => {
    const lower = letter.toLowerCase();
    return letter === lower ? letter.toUpperCase() : lower;
  });
}

let grantSeq = 0;

/**
 * The secrets with a grant no other test sends: in-flight refreshes are shared per refresh token.
 * The suffix goes at the end, after the shape under test, and `-` and digits pass every reshaping
 * unchanged, so each listed shape stays a prefix of the one the request sends.
 */
function withFreshGrant(secrets: SentSecrets): SentSecrets {
  grantSeq += 1;
  return { ...secrets, grant: `${secrets.grant}-${grantSeq}` };
}

const ECHOING_FLOWS = [
  {
    action: 'token refresh',
    grantField: 'refresh_token',
    redactedForm:
      'grant_type=refresh_token&client_id=client-id&client_secret=[redacted]&refresh_token=[redacted]',
    run: async ({ client, grant }: SentSecrets) =>
      new OAuthService().getAccessToken(
        googleConfig({ clientSecret: client, refreshToken: grant }),
      ),
  },
  {
    action: 'code exchange',
    grantField: 'code',
    redactedForm:
      'grant_type=authorization_code&client_id=client-id&client_secret=[redacted]&code=[redacted]' +
      '&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcb',
    run: async ({ client, grant }: SentSecrets) =>
      OAuthService.exchangeCode(
        googleConfig({ clientSecret: client }),
        grant,
        'http://localhost:3000/cb',
      ),
  },
] as const;

const ECHO_FIELDS = [
  {
    field: 'error',
    cap: TOKEN_ERROR_CODE_MAX_CHARS,
    body: (text: string) => ({ error: text }),
    named: (kept: string) => kept,
    dropped: '',
  },
  {
    field: 'error_description',
    cap: TOKEN_ERROR_DESCRIPTION_MAX_CHARS,
    body: (text: string) => ({ error: 'invalid_grant', error_description: text }),
    named: (kept: string) => `invalid_grant: ${kept}`,
    dropped: ': invalid_grant',
  },
] as const;

interface Echo {
  name: string;
  secrets: SentSecrets;
  echo: (sent: { client: string; grant: string; cap: number }) => string;
  kept: (cap: number) => string;
}

const ECHOES: Echo[] = [
  {
    name: 'the sent secrets in prose',
    secrets: PLAIN,
    echo: ({ client, grant }) => `grant ${grant} of ${client} revoked`,
    kept: () => 'grant [redacted] of [redacted] revoked',
  },
  {
    name: 'a sent secret the cap would cut',
    secrets: PLAIN,
    echo: ({ grant, cap }) => `${'w'.repeat(cap - 20)}${grant} revoked`,
    kept: (cap) => `${'w'.repeat(cap - 20)}[redacted] revoked`,
  },
  {
    name: 'a secret split by CR LF at the cap',
    secrets: PLAIN,
    echo: ({ grant, cap }) =>
      `${'w'.repeat(cap - 20)}${grant.slice(0, 9)}\r\n${grant.slice(9)} revoked`,
    kept: (cap) => `${'w'.repeat(cap - 20)}[redacted] revoked`,
  },
  {
    name: 'secrets with dropped characters',
    secrets: QUOTED,
    echo: ({ client, grant }) => `grant ${grant} of ${client} revoked`,
    kept: () => 'grant [redacted] of [redacted] revoked',
  },
  {
    name: 'those secrets escaped as JSON strings',
    secrets: QUOTED,
    echo: ({ client, grant }) =>
      `grant ${JSON.stringify(grant)} of ${JSON.stringify(client)} revoked`,
    kept: () => 'grant [redacted] of [redacted] revoked',
  },
  {
    name: 'the secrets percent-encoded for a URL',
    secrets: PERCENT,
    echo: ({ client, grant }) =>
      `retry at /authorize?secret=${encodeURIComponent(client)}&grant=${encodeURIComponent(grant)}`,
    kept: () => 'retry at /authorize?secret=[redacted]&grant=[redacted]',
  },
  {
    name: 'the sent secrets form-encoded',
    secrets: PERCENT,
    echo: ({ client, grant }) =>
      `bad form ${new URLSearchParams({ client_secret: client, grant }).toString()}`,
    kept: () => 'bad form client_secret=[redacted]&grant=[redacted]',
  },
  {
    name: 'URL-encoded with lowercase escapes',
    secrets: CASED_ESCAPES,
    echo: ({ client, grant }) =>
      lowercaseEscapes(
        `retry at /authorize?secret=${encodeURIComponent(client)}&grant=${encodeURIComponent(grant)}`,
      ),
    kept: () => 'retry at /authorize?secret=[redacted]&grant=[redacted]',
  },
  {
    name: 'URL-encoded with mixed-case escapes',
    secrets: CASED_ESCAPES,
    echo: ({ client, grant }) =>
      mixedCaseEscapes(
        `retry at /authorize?secret=${encodeURIComponent(client)}&grant=${encodeURIComponent(grant)}`,
      ),
    kept: () => 'retry at /authorize?secret=[redacted]&grant=[redacted]',
  },
  {
    name: 'form-encoded with lowercase escapes',
    secrets: CASED_ESCAPES,
    echo: ({ client, grant }) =>
      `bad form ${lowercaseEscapes(new URLSearchParams({ client_secret: client, grant }).toString())}`,
    kept: () => 'bad form client_secret=[redacted]&grant=[redacted]',
  },
  {
    name: 'form-encoded with mixed-case escapes',
    secrets: CASED_ESCAPES,
    echo: ({ client, grant }) =>
      `bad form ${mixedCaseEscapes(new URLSearchParams({ client_secret: client, grant }).toString())}`,
    kept: () => 'bad form client_secret=[redacted]&grant=[redacted]',
  },
  {
    name: 'secrets made of regex syntax',
    secrets: REGEX_SYNTAX,
    echo: ({ client, grant }) => `grant ${grant} of ${client} revoked`,
    kept: () => 'grant [redacted] of [redacted] revoked',
  },
  {
    name: 'a secret that starts with the other',
    secrets: NESTED,
    echo: ({ grant }) => `grant ${grant} revoked`,
    kept: () => 'grant [redacted] revoked',
  },
  {
    name: 'two secrets that overlap',
    secrets: OVERLAPPING,
    echo: ({ client, grant }) => `grant ${client.slice(0, 9)}${grant} revoked`,
    kept: () => 'grant [redacted] revoked',
  },
  {
    name: 'the two secrets back to back',
    secrets: PLAIN,
    echo: ({ client, grant }) => `grant ${client}${grant} revoked`,
    kept: () => 'grant [redacted] revoked',
  },
  {
    name: 'the two secrets a space apart',
    secrets: PLAIN,
    echo: ({ client, grant }) => `grant ${client} ${grant} revoked`,
    kept: () => 'grant [redacted] [redacted] revoked',
  },
  {
    name: 'a secret overlapping its own echo',
    secrets: SELF_OVERLAPPING,
    echo: ({ client }) => `client ${client}${client.slice(6)} refused`,
    kept: () => 'client [redacted] refused',
  },
  {
    name: 'a secret inside the other',
    secrets: CONTAINED,
    echo: ({ grant }) => `grant ${grant} revoked`,
    kept: () => 'grant [redacted] revoked',
  },
  {
    name: 'a secret broken by a dropped character around the other',
    secrets: CLIENT_INSIDE_GRANT,
    echo: ({ grant }) => `grant ${grant.slice(0, 4)}"${grant.slice(4)} revoked`,
    kept: () => 'grant [redacted] revoked',
  },
  // Three copies: the raw and the filtered scan could each replace one if they stopped at the first.
  {
    name: 'one secret echoed three times',
    secrets: PLAIN,
    echo: ({ grant }) => `${grant}, ${grant} and ${grant} revoked`,
    kept: () => '[redacted], [redacted] and [redacted] revoked',
  },
  {
    name: 'a secret of dropped characters only',
    secrets: DROPPED_ONLY,
    echo: ({ client }) => `client ${client} refused`,
    kept: () => 'client [redacted] refused',
  },
];

const ECHO_CASES = ECHOES.flatMap((echo) => ECHO_FIELDS.map((field) => ({ ...echo, ...field })));

/**
 * Near misses: only an escape's hex digits match in either case, and nothing else matches loosely.
 * These were never sent, so they stay.
 */
const UNSENT_ECHOES: {
  name: string;
  secrets: SentSecrets;
  echo: (sent: { client: string; grant: string }) => string;
}[] = [
  {
    name: 'the grant in swapped case',
    secrets: PLAIN,
    echo: ({ grant }) => swapCase(grant),
  },
  {
    name: 'the URL-encoded grant in swapped case',
    secrets: PLAIN,
    echo: ({ grant }) => swapCase(encodeURIComponent(grant)),
  },
  {
    name: 'hex letters after an escape lowered',
    secrets: { ...PLAIN, client: 'GOCSPX-9/CAFE' },
    echo: ({ client }) => encodeURIComponent(client).replaceAll('CAFE', 'cafe'),
  },
  {
    name: 'the client with a colon for its dot',
    secrets: { ...PLAIN, client: 'GOCSPX-q7.Lw2Rt9' },
    echo: ({ client }) => client.replaceAll('.', ':'),
  },
  {
    name: 'a literal %2F in the client as %2f',
    secrets: { ...PLAIN, client: 'GOCSPX-q7%2Fw2Rt9' },
    echo: ({ client }) => client.replaceAll('%2F', '%2f'),
  },
];

/**
 * Client secrets made of the marker's own letters: a pass over text it already marked would
 * split a marker. Checked by the whole message, since the leak oracle finds them in the marker.
 */
const MARKER_LETTER_CASES = [
  { name: 'a client secret inside the marker', client: 'redacted' },
  { name: 'a client secret equal to the marker', client: '[redacted]' },
].flatMap((secret) => ECHO_FIELDS.map((field) => ({ ...secret, ...field })));

/** Neither field holds the short secrets below: `server_error` has no `a`, no `red` and no `Zq`. */
const SHORT_SECRET_FIELDS = [
  { field: 'error', body: (text: string) => ({ error: text }), dropped: '' },
  {
    field: 'error_description',
    body: (text: string) => ({ error: 'server_error', error_description: text }),
    dropped: ': server_error',
  },
] as const;

/** Each client secret, or one of its shapes, is shorter than the minimum and sits in the prose. */
const SHORT_SECRET_CASES = [
  {
    name: 'a one-letter client secret',
    client: 'a',
    prose: 'a grant that was revoked cannot be used again as a refresh',
  },
  {
    name: 'a client secret made of marker letters',
    client: 'red',
    prose: 'the redirect was refused',
  },
  {
    name: 'a long client secret whose filtered shape is short',
    client: 'ÿéßüöäñZq',
    prose: 'client Zq is unknown',
  },
].flatMap((secret) => SHORT_SECRET_FIELDS.map((field) => ({ ...secret, ...field })));

/** Written out, not sliced to the constant: each test checks the length against it. */
const AT_THE_MINIMUM_CASES = ECHO_FIELDS.map((field) => ({ ...field, client: 'q7Lw2Rt9' }));
const UNDER_THE_MINIMUM_CASES = ECHO_FIELDS.map((field) => ({ ...field, client: 'q7Lw2Rt' }));

const BROKEN_AROUND_GRANT_CASES = [
  { name: 'a quote', echo: 'ABCD"EFGHIJKLMNOPQRSTUVWX' },
  { name: 'an emoji of two UTF-16 units', echo: 'ABCD\u{1F4A5}EFGHIJKLMNOPQRSTUVWX' },
].flatMap((broken) => ECHO_FIELDS.map((field) => ({ ...broken, ...field })));

describe.each(ECHOING_FLOWS)(
  'OAuthService $action when the refusal echoes the secrets the request sent',
  ({ action, grantField, redactedForm, run }) => {
    const failed = `OAuth2 ${action} failed`;

    async function refusedEchoing(
      fixture: SentSecrets,
      fields: (sent: { client: string; grant: string; form: string }) => Record<string, unknown>,
      { freshGrant = true } = {},
    ) {
      const secrets = freshGrant ? withFreshGrant(fixture) : fixture;
      const calls = fakeTokenEndpoint(
        echoingRefusal((sent, form) =>
          fields({
            client: sent.get('client_secret') ?? '',
            grant: sent.get(grantField) ?? '',
            form,
          }),
        ),
      );
      const error = await failureOf(async () => run(secrets));
      const sent = new URLSearchParams(String(calls[0]?.init.body));
      return { error, secrets, sent: [sent.get('client_secret'), sent.get(grantField)] };
    }

    it.each(ECHO_CASES)(
      'should replace $name with [redacted] in the $field',
      async ({ secrets: fixture, echo, kept, cap, body, named }) => {
        const { error, secrets, sent } = await refusedEchoing(fixture, ({ client, grant }) =>
          body(echo({ client, grant, cap })),
        );
        expect({
          sent,
          message: error.message,
          leaked: leakedSecretsIn(error, [secrets.client, secrets.grant, ...secrets.reshaped], {
            fragments: true,
          }),
        }).toEqual({
          sent: [secrets.client, secrets.grant],
          message: `${failed} (400): ${named(kept(cap))}`,
          leaked: [],
        });
      },
    );

    it.each(BROKEN_AROUND_GRANT_CASES)(
      'should replace the whole client secret with [redacted] when $name breaks its echo around the grant in the $field',
      async ({ echo, body, named }) => {
        const { error, secrets, sent } = await refusedEchoing(
          GRANT_INSIDE_CLIENT,
          () => body(echo),
          { freshGrant: false },
        );
        expect({
          sent,
          message: error.message,
          leaked: leakedSecretsIn(error, [secrets.client, secrets.grant], { fragments: true }),
        }).toEqual({
          sent: [secrets.client, secrets.grant],
          message: `${failed} (400): ${named('[redacted]')}`,
          leaked: [],
        });
      },
    );

    it.each(ECHO_FIELDS)(
      'should drop the $field when the text around a redacted grant spells the client secret',
      async ({ body, dropped }) => {
        const { error, secrets, sent } = await refusedEchoing(AROUND_A_MARKER, ({ grant }) =>
          body(`AA${grant}ZZ`),
        );
        expect({
          sent,
          message: error.message,
          leaked: leakedSecretsIn(error, [secrets.client, secrets.grant], { fragments: true }),
        }).toEqual({
          sent: [secrets.client, secrets.grant],
          message: `${failed} (400)${dropped}`,
          leaked: [],
        });
      },
    );

    it('should replace the secrets with [redacted] when the description echoes the whole form sent', async () => {
      const { error, secrets, sent } = await refusedEchoing(PERCENT, ({ form }) => ({
        error: 'invalid_request',
        error_description: `could not parse ${form}`,
      }));
      expect({
        sent,
        message: error.message,
        leaked: leakedSecretsIn(error, [secrets.client, secrets.grant, ...secrets.reshaped], {
          fragments: true,
        }),
      }).toEqual({
        sent: [secrets.client, secrets.grant],
        message: `${failed} (400): invalid_request: could not parse ${redactedForm}`,
        leaked: [],
      });
    });

    it('should replace a client secret holding a lone surrogate with [redacted] in the error_description', async () => {
      const { error, secrets, sent } = await refusedEchoing(LONE_SURROGATE, ({ client }) => ({
        error: 'invalid_client',
        error_description: `client ${client} refused`,
      }));
      expect({
        sent,
        message: error.message,
        leaked: leakedSecretsIn(error, [secrets.client, ...secrets.reshaped], {
          fragments: true,
        }),
      }).toEqual({
        sent: ['GOCSPX-a1b2c3d4�z9y8x7w6v5', secrets.grant],
        message: `${failed} (400): invalid_client: client [redacted] refused`,
        leaked: [],
      });
    });

    it.each(UNSENT_ECHOES)(
      'should keep $name as echoed in the error_description',
      async ({ secrets: fixture, echo }) => {
        const { error, secrets } = await refusedEchoing(fixture, (sent) => ({
          error: 'invalid_grant',
          error_description: `token ${echo(sent)} refused`,
        }));
        expect(error.message).toBe(
          `${failed} (400): invalid_grant: token ${echo(secrets)} refused`,
        );
      },
    );

    it.each(MARKER_LETTER_CASES)(
      'should leave one whole [redacted] for $name in the $field',
      async ({ client, body, named }) => {
        const { error } = await refusedEchoing({ ...PLAIN, client }, (sent) =>
          body(`${sent.client} is wrong`),
        );
        expect(error.message).toBe(`${failed} (400): ${named('[redacted] is wrong')}`);
      },
    );

    it.each(SHORT_SECRET_CASES)(
      'should drop the $field rather than cut $name out of its prose',
      async ({ client, prose, body, dropped }) => {
        const { error, sent } = await refusedEchoing({ ...PLAIN, client }, () => body(prose));
        expect({ sentClient: sent[0], message: error.message }).toEqual({
          sentClient: client,
          message: `${failed} (400)${dropped}`,
        });
      },
    );

    it('should keep a refusal whole when it does not hold a client secret shorter than the minimum', async () => {
      const { error } = await refusedEchoing({ ...PLAIN, client: 'Zq7' }, () => ({
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      }));
      expect(error.message).toBe(
        `${failed} (400): invalid_grant: Token has been expired or revoked.`,
      );
    });

    it.each(AT_THE_MINIMUM_CASES)(
      'should replace a client secret exactly as long as the minimum with [redacted] in the $field',
      async ({ client, body, named }) => {
        const { error } = await refusedEchoing({ ...PLAIN, client }, (sent) =>
          body(`client ${sent.client} refused`),
        );
        expect({
          length: client.length,
          message: error.message,
          leaked: leakedSecretsIn(error, [client], { fragments: true }),
        }).toEqual({
          length: SECRET_SHAPE_MIN_CHARS,
          message: `${failed} (400): ${named('client [redacted] refused')}`,
          leaked: [],
        });
      },
    );

    it.each(UNDER_THE_MINIMUM_CASES)(
      'should drop the $field when it holds a client secret one character under the minimum',
      async ({ client, body, dropped }) => {
        const { error } = await refusedEchoing({ ...PLAIN, client }, (sent) =>
          body(`client ${sent.client} refused`),
        );
        expect({
          length: client.length,
          message: error.message,
          leaked: leakedSecretsIn(error, [client], { fragments: true }),
        }).toEqual({
          length: SECRET_SHAPE_MIN_CHARS - 1,
          message: `${failed} (400)${dropped}`,
          leaked: [],
        });
      },
    );

    it.each([
      { name: 'empty', client: '' },
      { name: 'made only of characters the error charset drops', client: 'ÿéß' },
    ])(
      'should leave a refusal that echoes nothing as it was when the client secret is $name',
      async ({ client }) => {
        fakeTokenEndpoint(leakyInvalidGrant(400));
        const error = await failureOf(async () => run(withFreshGrant({ ...PLAIN, client })));
        expect(error.message).toBe(
          `${failed} (400): invalid_grant: Token has been expired or revoked.`,
        );
      },
    );
  },
);

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
