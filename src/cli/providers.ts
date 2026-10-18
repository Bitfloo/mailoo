/**
 * Email provider auto-detection by domain.
 *
 * Maps common email domains to their IMAP/SMTP server settings.
 */

import type { ProviderConfig } from '../types/index.js';

export const PROVIDERS: ProviderConfig[] = [
  {
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: {
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.gmail.com',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    notes: 'Requires an App Password (enable 2FA first) or OAuth2',
  },
  {
    name: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'outlook.de', 'outlook.co.uk'],
    imap: {
      host: 'outlook.office365.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.office365.com',
      port: 587,
      tls: false,
      starttls: true,
      verifySsl: true,
    },
  },
  {
    name: 'Yahoo Mail',
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.de', 'ymail.com'],
    imap: {
      host: 'imap.mail.yahoo.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.mail.yahoo.com',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    notes: 'Requires an App Password',
  },
  {
    name: 'iCloud',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: {
      host: 'imap.mail.me.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.mail.me.com',
      port: 587,
      tls: false,
      starttls: true,
      verifySsl: true,
    },
    notes: 'Requires an App-Specific Password',
  },
  {
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm'],
    imap: {
      host: 'imap.fastmail.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.fastmail.com',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
  },
  {
    name: 'ProtonMail Bridge',
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    imap: {
      host: '127.0.0.1',
      port: 1143,
      tls: false,
      starttls: true,
      verifySsl: false,
    },
    smtp: {
      host: '127.0.0.1',
      port: 1025,
      tls: false,
      starttls: true,
      verifySsl: false,
    },
    notes: 'Requires ProtonMail Bridge running locally',
  },
  {
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imap: {
      host: 'imap.zoho.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'smtp.zoho.com',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
  },
  {
    name: 'GMX',
    domains: ['gmx.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'],
    imap: {
      host: 'imap.gmx.net',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
    smtp: {
      host: 'mail.gmx.net',
      port: 465,
      tls: true,
      starttls: false,
      verifySsl: true,
    },
  },
];

/**
 * Detect email provider from an email address.
 * Returns the matching provider config or undefined.
 */
export function detectProvider(email: string): ProviderConfig | undefined {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return undefined;

  return PROVIDERS.find((p) => p.domains.includes(domain));
}
