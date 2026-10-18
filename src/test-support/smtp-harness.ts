/** Mocks shared by the SmtpService unit suites. */

import type { Mock } from 'vitest';
import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from '../services/imap.service.js';

export interface MockTransport {
  sendMail: Mock;
}

export type MockConnections = Record<keyof IConnectionManager, Mock>;

interface ServerSettings {
  host: string;
  port: number;
  tls: boolean;
  starttls: boolean;
  verifySsl: boolean;
}

export interface SmtpAccount {
  name: string;
  email: string;
  username: string;
  imap: ServerSettings;
  smtp: ServerSettings;
  oauth2?: { provider: string };
}

export function createMockTransport(): MockTransport {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

export function createMockConnectionManager(mockTransport: MockTransport): MockConnections {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      fullName: 'Test User',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    resolveAccountName: vi.fn().mockReturnValue('test'),
    getImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

export function createMockRateLimiter(allowed = true): RateLimiter {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

export function accountWithSmtp(host: string, oauthProvider?: string): SmtpAccount {
  return {
    name: 'test',
    email: 'user@example.com',
    username: 'user@example.com',
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host, port: 465, tls: true, starttls: false, verifySsl: true },
    ...(oauthProvider ? { oauth2: { provider: oauthProvider } } : {}),
  };
}

export function createMockImapService(): ImapService {
  return {
    getEmail: vi.fn().mockResolvedValue({
      subject: 'Original',
      from: { name: 'Alice', address: 'alice@example.com' },
      to: [{ address: 'bob@example.com' }],
      date: '2026-01-01T00:00:00.000Z',
      bodyText: 'plain original',
      bodyHtml: '<p>html original</p>',
      messageId: '<orig@example.com>',
      references: [],
      attachments: [],
    }),
    downloadAttachment: vi.fn(),
    fetchDraft: vi.fn(),
    deleteDraft: vi.fn(),
    appendSentMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as ImapService;
}
