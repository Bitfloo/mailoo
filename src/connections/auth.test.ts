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

describe('buildSmtpAuth', () => {
  it('should use the password when the account has no oauth2 block', async () => {
    const auth = await buildSmtpAuth(passwordAccount, tokenSource('unused'));
    expect(auth).toEqual({ user: 'me@example.com', pass: 'app-password' });
  });

  it('should select XOAUTH2 with the access token when a token source is given', async () => {
    const auth = await buildSmtpAuth(oauthAccount, tokenSource('ya29.token'));
    expect(auth).toEqual({ type: 'OAuth2', user: 'me@example.com', accessToken: 'ya29.token' });
  });
});
