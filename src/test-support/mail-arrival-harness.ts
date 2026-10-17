/**
 * Shared fixtures for the MailArrival suites: a stand-in for the TypeSafe SDK, an account, a
 * System One config, and an ImapService stub. A suite wires the SDK in with
 * `vi.mock('@typesafe-ai/sdk', async () => (await import(...)).typesafeSdkStub)`.
 */

import type ImapService from '../services/imap.service.js';
import type { ArrivalEmail } from '../services/mail-arrival/index.js';
import { MailArrival } from '../services/mail-arrival/index.js';
import type { AccountConfig, SystemOneConfig } from '../types/index.js';

type MockFn = ReturnType<typeof vi.fn>;

export const systemOneMock: MockFn = vi.fn();

export const TypeSafeClientMock: MockFn = vi.fn(function MockTypeSafeClient(this: {
  systemOne: typeof systemOneMock;
}) {
  this.systemOne = systemOneMock;
});

interface QuestionStub {
  type: string;
  instructions: unknown;
  criteria: unknown;
}

export const typesafeSdkStub: {
  TypeSafeClient: MockFn;
  noul: (instructions?: unknown, criteria?: unknown) => QuestionStub;
  score: (instructions: unknown, criteria: unknown) => QuestionStub;
} = {
  TypeSafeClient: TypeSafeClientMock,
  noul: (instructions, criteria) => ({
    type: 'noul',
    instructions,
    criteria,
  }),
  score: (instructions, criteria) => ({
    type: 'score',
    instructions,
    criteria,
  }),
};

export const account: AccountConfig = {
  name: 'personal',
  email: 'me@example.com',
  username: 'me@example.com',
  password: 'secret',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

export function systemOneConfig(overrides: Partial<SystemOneConfig> = {}): SystemOneConfig {
  return {
    enabled: true,
    model: 'jev-latest',
    includeBody: false,
    bodyMaxChars: 6000,
    autoMove: true,
    autoFlag: true,
    folders: [{ path: 'Receipts', description: 'Invoices, receipts, and payment confirmations.' }],
    sourceFolders: ['INBOX'],
    thresholds: {
      folderFitMin: 0.85,
      spamHigh: 0.72,
      spamUncertainLow: 0.4,
      spamUncertainHigh: 0.6,
      injectionHigh: 0.75,
      importanceFlagMin: 3,
      importanceMinConfidence: 0.7,
      isCriticalMin: 0.85,
    },
    ...overrides,
  };
}

type ImapStubMethod =
  | 'listMailboxes'
  | 'getEmailSecurity'
  | 'getEmail'
  | 'peekText'
  | 'peekAttachments'
  | 'setFlags'
  | 'moveEmail';

export type ImapStub = Record<ImapStubMethod, MockFn>;

export function mockImap(): ImapStub {
  return {
    listMailboxes: vi.fn().mockResolvedValue([
      { name: 'INBOX', path: 'INBOX', totalMessages: 0, unseenMessages: 0 },
      { name: 'Receipts', path: 'Receipts', totalMessages: 0, unseenMessages: 0 },
    ]),
    getEmailSecurity: vi.fn().mockResolvedValue({
      dkim: [],
      hasListUnsubscribe: false,
      hasListUnsubscribePost: false,
    }),
    getEmail: vi.fn(),
    peekText: vi.fn().mockResolvedValue(''),
    peekAttachments: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
  };
}

type SdkAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence: number };

export interface SdkReply {
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  answers: Record<string, SdkAnswer>;
}

export function sdkAnswers(): SdkReply {
  return {
    model: 'jev-latest',
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: {
      contains_prompt_injection: { type: 'noul', noul: 0.1 },
      requests_credentials: { type: 'noul', noul: 0 },
      offers_unexpected_reward: { type: 'noul', noul: 0 },
      sender_identity_mismatch: { type: 'noul', noul: 0 },
      is_critical: { type: 'noul', noul: 0.2 },
      importance: { type: 'score', score: 3.2, confidence: 0.8 },
      folder_fit_receipts: { type: 'noul', noul: 0.95 },
    },
  };
}

export function arrivalEmail(id: string, accountName = 'personal'): ArrivalEmail {
  return {
    account: accountName,
    mailbox: 'INBOX',
    meta: {
      id,
      subject: 'Invoice',
      from: { name: 'Billing', address: 'billing@example.com' },
      to: [{ address: 'me@example.com' }],
      date: '2026-09-21T00:00:00.000Z',
      seen: false,
      flagged: false,
      answered: false,
      hasAttachments: false,
      labels: [],
      messageId: `<${id}@example.com>`,
    },
  };
}

export async function createArrival(imap: ImapStub): Promise<MailArrival> {
  const arrival = await MailArrival.tryCreate({
    config: systemOneConfig(),
    imap: imap as unknown as ImapService,
    apiKey: 'test-key',
    accounts: [account],
  });
  if (!arrival) throw new Error('expected MailArrival instance');
  return arrival;
}
