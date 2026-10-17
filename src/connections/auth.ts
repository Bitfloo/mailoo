/**
 * IMAP and SMTP credentials for an account, password or OAuth2.
 */

import type { AccountConfig } from '../types/index.js';
import type { AccessTokenSource } from './types.js';

export type ImapAuth = { user: string; pass?: string } | { user: string; accessToken: string };

export type SmtpAuth =
  | { user: string; pass?: string }
  | { type: 'OAuth2'; user: string; accessToken: string };

export async function buildImapAuth(
  account: AccountConfig,
  tokens?: AccessTokenSource,
): Promise<ImapAuth> {
  if (account.oauth2 && tokens) {
    return { user: account.username, accessToken: await tokens.getAccessToken(account.oauth2) };
  }
  return { user: account.username, pass: account.password };
}

export async function buildSmtpAuth(
  account: AccountConfig,
  tokens?: AccessTokenSource,
): Promise<SmtpAuth> {
  if (account.oauth2 && tokens) {
    return {
      type: 'OAuth2',
      user: account.username,
      accessToken: await tokens.getAccessToken(account.oauth2),
    };
  }
  return { user: account.username, pass: account.password };
}
