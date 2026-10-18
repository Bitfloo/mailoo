import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type { AccountConfig } from '../types/index.js';

export interface IConnectionManager {
  getAccount: (name?: string) => AccountConfig;
  resolveAccountName?: (name?: string) => string;
  getAccountNames: () => string[];
  getImapClient: (accountName?: string) => Promise<ImapFlow>;
  getSmtpTransport: (accountName?: string, options?: { verify?: boolean }) => Promise<Transporter>;
  closeAll: () => Promise<void>;
}
