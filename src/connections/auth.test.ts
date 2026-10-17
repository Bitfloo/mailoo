import type { AccountConfig, OAuth2Config } from '../types/index.js';
import { buildImapAuth, buildSmtpAuth } from './auth.js';
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

  it('should hand a token refresh failure to nodemailer as an error', async () => {
    const tokens: AccessTokenSource = {
      getAccessToken: async () => {
        throw new Error('OAuth2 token refresh failed (400): invalid_grant');
      },
    };
    const result = await provision(buildSmtpAuth(oauthAccount, tokens));
    expect(result.err?.message).toBe('OAuth2 token refresh failed (400): invalid_grant');
  });
});
