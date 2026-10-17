/**
 * IMAP and SMTP credentials for an account, password or OAuth2.
 */

import type { XOAuth2ProvisionCallback } from 'nodemailer/lib/xoauth2';

import type { AccountConfig } from '../types/index.js';
import type { AccessTokenSource } from './types.js';

export type ImapAuth = { user: string; pass?: string } | { user: string; accessToken: string };

export type SmtpAuth =
  | { user: string; pass?: string }
  | { type: 'OAuth2'; user: string; provisionCallback: XOAuth2ProvisionCallback };

export async function buildImapAuth(
  account: AccountConfig,
  tokens?: AccessTokenSource,
): Promise<ImapAuth> {
  if (account.oauth2 && tokens) {
    return { user: account.username, accessToken: await tokens.getAccessToken(account.oauth2) };
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
