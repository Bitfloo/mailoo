import type { AccountConfig, OAuth2Config } from '../types/index.js';
import { buildImapAuth, buildSmtpAuth, sentCredentials } from './auth.js';
import { redactSentCredentials } from './credential-redaction.js';
import type { AccessTokenSource } from './types.js';

const passwordAccount: AccountConfig = {
  name: 'personal',
  email: 'me@example.com',
  username: 'me@example.com',
  password: 'app-password',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

// OAuth accounts carry no password: the config schema leaves it empty for oauth2 accounts.
const oauthAccount: AccountConfig = {
  ...passwordAccount,
  name: 'work',
  password: undefined,
  oauth2: {
    provider: 'google',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
  },
};

function tokenSource(token: string): AccessTokenSource & { seen: OAuth2Config[] } {
  const seen: OAuth2Config[] = [];
  return {
    seen,
    getAccessToken: async (oauth2) => {
      seen.push(oauth2);
      return token;
    },
  };
}

describe('buildImapAuth', () => {
  it('should use the password when the account has no oauth2 block', async () => {
    const auth = await buildImapAuth(passwordAccount, tokenSource('unused'));
    expect(auth).toEqual({ user: 'me@example.com', pass: 'app-password' });
  });

  it('should use the access token of the account oauth2 block when a token source is given', async () => {
    const tokens = tokenSource('ya29.token');
    const auth = await buildImapAuth(oauthAccount, tokens);
    expect(auth).toEqual({ user: 'me@example.com', accessToken: 'ya29.token' });
    expect(tokens.seen).toEqual([oauthAccount.oauth2]);
  });
});

async function provision(
  auth: ReturnType<typeof buildSmtpAuth>,
): Promise<{ err: Error | null; token?: string; expires?: number }> {
  if (!('provisionCallback' in auth)) throw new Error('expected an OAuth2 auth object');
  return new Promise((resolve) => {
    auth.provisionCallback('me@example.com', false, (err, token, expires) => {
      resolve({ err, token, expires });
    });
  });
}

describe('buildSmtpAuth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should use the password when the account has no oauth2 block', () => {
    const auth = buildSmtpAuth(passwordAccount, tokenSource('unused'));
    expect(auth).toEqual({ user: 'me@example.com', pass: 'app-password' });
  });

  it('should select XOAUTH2 for the account user when a token source is given', () => {
    const auth = buildSmtpAuth(oauthAccount, tokenSource('ya29.token'));
    expect(auth).toMatchObject({ type: 'OAuth2', user: 'me@example.com' });
    expect(auth).not.toHaveProperty('accessToken');
  });

  it('should provision the current token with the expiry the token source cached', async () => {
    const account = structuredClone(oauthAccount);
    const tokens: AccessTokenSource = {
      getAccessToken: async (oauth2) => {
        Object.assign(oauth2, { accessToken: 'ya29.token', tokenExpiry: 1_790_000_000_000 });
        return 'ya29.token';
      },
    };
    const result = await provision(buildSmtpAuth(account, tokens));
    expect(result).toEqual({ err: null, token: 'ya29.token', expires: 1_790_000_000_000 });
  });

  it('should provision an expiry of now when the token source cached none', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T08:00:00.000Z'));
    const result = await provision(
      buildSmtpAuth(structuredClone(oauthAccount), tokenSource('ya29.token')),
    );
    expect(result).toEqual({
      err: null,
      token: 'ya29.token',
      expires: new Date('2026-10-01T08:00:00.000Z').getTime(),
    });
  });

  it('should hand a token refresh failure to nodemailer as an error', async () => {
    const tokens: AccessTokenSource = {
      getAccessToken: async () => {
        throw new Error('OAuth2 token refresh failed (400): invalid_grant');
      },
    };
    const result = await provision(buildSmtpAuth(oauthAccount, tokens));
    expect(result.err?.message).toBe('OAuth2 token refresh failed (400): invalid_grant');
  });

  it('should hand a non-Error refresh failure to nodemailer as an Error', async () => {
    const tokens: AccessTokenSource = {
      // eslint-disable-next-line prefer-promise-reject-errors -- the case under test: a bare string
      getAccessToken: async () => Promise.reject('invalid_grant'),
    };
    const { err } = await provision(buildSmtpAuth(oauthAccount, tokens));
    expect({ isError: err instanceof Error, message: err?.message }).toEqual({
      isError: true,
      message: 'invalid_grant',
    });
  });
});

describe('sentCredentials', () => {
  const SMTP_TOKEN = 'ya29.fake-smtp-token-0123456789';
  const IMAP_TOKEN = 'ya29.fake-imap-token-0123456789';

  // nodemailer keeps sending the token it was handed after an IMAP login is issued a newer one,
  // and the token source hands that newer token to every later IMAP login until it expires.
  it.each([
    ['one IMAP login', 1],
    ['ten IMAP logins', 10],
  ])(
    'should still redact the token SMTP was handed once a newer one went to %s',
    async (_logins, imapLogins) => {
      const account = structuredClone(oauthAccount);
      let current = SMTP_TOKEN;
      const tokens: AccessTokenSource = { getAccessToken: async () => current };
      await provision(buildSmtpAuth(account, tokens));
      current = IMAP_TOKEN;
      await Promise.all(
        Array.from({ length: imapLogins }, async () => buildImapAuth(account, tokens)),
      );
      const reply = `535 5.7.8 Token ${SMTP_TOKEN} is not valid`;
      expect(redactSentCredentials(reply, sentCredentials(account))).toBe(
        '535 5.7.8 Token [redacted] is not valid',
      );
    },
  );

  // The first token refresh can fail, and its error is redacted with these all the same.
  it('should list only the account password for an OAuth2 account no token was issued to', () => {
    expect(sentCredentials(structuredClone(oauthAccount)).secrets).toEqual([undefined]);
  });

  const issuedToken = (n: number) => `ya29.fake-issued-token-${n}-0123456789`;

  /** One IMAP login per token, tokens 1 to `count` in turn. */
  async function issueInTurn(account: AccountConfig, count: number): Promise<void> {
    let current = '';
    const tokens: AccessTokenSource = { getAccessToken: async () => current };
    for (let n = 1; n <= count; n += 1) {
      current = issuedToken(n);
      // eslint-disable-next-line no-await-in-loop -- the order of issue is the behaviour under test
      await buildImapAuth(account, tokens);
    }
  }

  it.each([
    ['all three of three tokens', 3, [1, 2, 3]],
    ['the four most recent of five tokens', 5, [2, 3, 4, 5]],
  ])('should redact %s issued in turn', async (_kept, issued, quoted) => {
    const account = structuredClone(oauthAccount);
    await issueInTurn(account, issued);
    const reply = `535 5.7.8 Tokens ${quoted.map(issuedToken).join(' ')} are not valid`;
    expect(redactSentCredentials(reply, sentCredentials(account))).toBe(
      `535 5.7.8 Tokens ${quoted.map(() => '[redacted]').join(' ')} are not valid`,
    );
  });

  it('should list the account password, then the four newest of six tokens issued in turn', async () => {
    const account = structuredClone(oauthAccount);
    await issueInTurn(account, 6);
    expect(sentCredentials(account).secrets).toEqual([undefined, ...[6, 5, 4, 3].map(issuedToken)]);
  });

  it('should no longer redact the two oldest of six tokens issued in turn', async () => {
    const account = structuredClone(oauthAccount);
    await issueInTurn(account, 6);
    const reply = `535 5.7.8 Tokens ${[1, 2, 3, 4, 5, 6].map(issuedToken).join(' ')} are not valid`;
    expect(redactSentCredentials(reply, sentCredentials(account))).toBe(
      `535 5.7.8 Tokens ${issuedToken(1)} ${issuedToken(2)} [redacted] [redacted] [redacted] [redacted] are not valid`,
    );
  });
});
