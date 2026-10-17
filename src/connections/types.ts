import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type { AccountConfig, OAuth2Config } from '../types/index.js';

export interface IConnectionManager {
  getAccount: (name: string) => AccountConfig;
  getAccountNames: () => string[];
  getImapClient: (accountName: string) => Promise<ImapFlow>;
  getSmtpTransport: (accountName: string, options?: { verify?: boolean }) => Promise<Transporter>;
  closeAll: () => Promise<void>;
}

/** Hands out a valid OAuth2 access token; OAuthService is the production implementation. */
export interface AccessTokenSource {
  getAccessToken: (oauth2: OAuth2Config) => Promise<string>;
}
