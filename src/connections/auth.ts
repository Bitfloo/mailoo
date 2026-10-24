import type { XOAuth2ProvisionCallback } from 'nodemailer/lib/xoauth2';

import type { AccountConfig, OAuth2Config } from '../types/index.js';
import type { SentCredentials } from './credential-redaction.js';
import type { AccessTokenSource } from './types.js';

export type ImapAuth = { user: string; pass?: string } | { user: string; accessToken: string };

export type SmtpAuth =
  | { user: string; pass?: string }
  | { type: 'OAuth2'; user: string; provisionCallback: XOAuth2ProvisionCallback };

/**
 * Distinct tokens handed to imapflow or nodemailer, newest first, whatever the token source
 * caches. A connection keeps the token it logged in with after a newer one is issued, so its error
 * can quote an older one. The source hands one token to every login until it expires, so a repeat
 * is dropped rather than pushing an older token out of the bound.
 */
const issuedTokens = new WeakMap<OAuth2Config, string[]>();

const ISSUED_TOKENS_KEPT = 4;

function recordIssuedToken(oauth2: OAuth2Config, token: string): void {
  const older = (issuedTokens.get(oauth2) ?? []).filter((issued) => issued !== token);
  issuedTokens.set(oauth2, [token, ...older].slice(0, ISSUED_TOKENS_KEPT));
}

/** What a login for this account put on the wire, for scrubbing the server's error reply. */
export function sentCredentials(account: AccountConfig): SentCredentials {
  const tokens = account.oauth2 ? (issuedTokens.get(account.oauth2) ?? []) : [];
  return { user: account.username, secrets: [account.password, ...tokens] };
}

export async function buildImapAuth(
  account: AccountConfig,
  tokens?: AccessTokenSource,
): Promise<ImapAuth> {
  if (account.oauth2 && tokens) {
    const accessToken = await tokens.getAccessToken(account.oauth2);
    recordIssuedToken(account.oauth2, accessToken);
    return { user: account.username, accessToken };
  }
  return { user: account.username, pass: account.password };
}

/**
 * The SMTP transport is cached for the life of the process, so an OAuth2 token baked into it
 * expires after about an hour. nodemailer asks the provision callback whenever its token is
 * missing or past the expiry handed back, which keeps every pooled connection current.
 */
export function buildSmtpAuth(account: AccountConfig, tokens?: AccessTokenSource): SmtpAuth {
  const { oauth2 } = account;
  if (oauth2 && tokens) {
    return {
      type: 'OAuth2',
      user: account.username,
      provisionCallback: (_user, _renew, callback) => {
        tokens.getAccessToken(oauth2).then(
          (accessToken) => {
            recordIssuedToken(oauth2, accessToken);
            // Without an expiry nodemailer would reuse the token forever.
            callback(null, accessToken, oauth2.tokenExpiry ?? Date.now());
          },
          (err: unknown) => {
            callback(err instanceof Error ? err : new Error(String(err)));
          },
        );
      },
    };
  }
  return { user: account.username, pass: account.password };
}
