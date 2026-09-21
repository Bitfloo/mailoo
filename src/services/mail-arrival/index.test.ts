import type { AccountConfig, SystemOneConfig } from '../../types/index.js';
import type ImapService from '../imap.service.js';
import { MailArrival } from './index.js';

const { systemOneMock, TypeSafeClientMock } = vi.hoisted(() => {
  const systemOne = vi.fn();
  const TypeSafeClient = vi.fn(function MockTypeSafeClient(this: { systemOne: typeof systemOne }) {
    this.systemOne = systemOne;
  });
  return { systemOneMock: systemOne, TypeSafeClientMock: TypeSafeClient };
});

vi.mock('@typesafe-ai/sdk', () => ({
  TypeSafeClient: TypeSafeClientMock,
  noul: (instructions?: unknown, criteria?: unknown) => ({
    type: 'noul',
    instructions,
    criteria,
  }),
  score: (instructions: unknown, criteria: unknown) => ({
    type: 'score',
    instructions,
    criteria,
  }),
}));

vi.mock('../../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../safety/audit.js', () => ({
  default: { log: vi.fn().mockResolvedValue(undefined), AUDIT_LOG_PATH: '/tmp/mailoo-audit.log' },
}));

const account: AccountConfig = {
  name: 'personal',
  email: 'me@example.com',
  username: 'me@example.com',
  password: 'secret',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

function systemOneConfig(overrides: Partial<SystemOneConfig> = {}): SystemOneConfig {
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

function mockImap() {
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

function sdkAnswers() {
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

describe('MailArrival.tryCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when enabled is false', async () => {
    const imap = mockImap();
    const result = await MailArrival.tryCreate({
      config: systemOneConfig({ enabled: false }),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    expect(result).toBeNull();
    expect(TypeSafeClientMock).not.toHaveBeenCalled();
    expect(imap.listMailboxes).not.toHaveBeenCalled();
  });

  it('returns null when apiKey is blank', async () => {
    const imap = mockImap();
    const result = await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: imap as unknown as ImapService,
      apiKey: '   ',
      accounts: [account],
    });
    expect(result).toBeNull();
    expect(TypeSafeClientMock).not.toHaveBeenCalled();
  });

  it('returns null on folder slug collision', async () => {
    const imap = mockImap();
    const result = await MailArrival.tryCreate({
      config: systemOneConfig({
        folders: [
          { path: 'Foo Bar', description: 'One.' },
          { path: 'foo_bar', description: 'Two.' },
        ],
      }),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    expect(result).toBeNull();
    expect(TypeSafeClientMock).not.toHaveBeenCalled();
  });

  it('returns an instance when folders[] is empty', async () => {
    const imap = mockImap();
    const result = await MailArrival.tryCreate({
      config: systemOneConfig({ folders: [] }),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    expect(result).not.toBeNull();
    expect(TypeSafeClientMock).toHaveBeenCalledOnce();
  });

  it('should still return an instance when listMailboxes rejects', async () => {
    const imap = mockImap();
    imap.listMailboxes.mockRejectedValue(new Error('LIST failed'));
    const result = await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    expect(result).not.toBeNull();
    expect(TypeSafeClientMock).toHaveBeenCalledOnce();
  });
});

describe('MailArrival.handle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemOneMock.mockResolvedValue(sdkAnswers());
  });

  it('STOREs flag then MOVEs; never calls getEmail', async () => {
    const imap = mockImap();
    const arrival = await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    if (!arrival) throw new Error('expected MailArrival instance');

    const action = await arrival.handle({
      account: 'personal',
      mailbox: 'INBOX',
      meta: {
        id: '10',
        subject: 'Invoice',
        from: { name: 'Billing', address: 'billing@example.com' },
        to: [{ address: 'me@example.com' }],
        date: '2026-09-21T00:00:00.000Z',
        seen: false,
        flagged: false,
        answered: false,
        hasAttachments: false,
        labels: [],
        messageId: '<mid@example.com>',
      },
    });

    expect(action).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: true,
    });
    expect(imap.setFlags).toHaveBeenCalledOnce();
    expect(imap.setFlags).toHaveBeenCalledWith('personal', '10', 'INBOX', 'flag');
    expect(imap.moveEmail).toHaveBeenCalledOnce();
    expect(imap.moveEmail).toHaveBeenCalledWith('personal', '10', 'INBOX', 'Receipts');
    const flagOrder = imap.setFlags.mock.invocationCallOrder[0];
    const moveOrder = imap.moveEmail.mock.invocationCallOrder[0];
    expect(flagOrder).toBeLessThan(moveOrder);
    expect(imap.peekAttachments).toHaveBeenCalledWith('personal', '10', 'INBOX');
    expect(imap.getEmail).not.toHaveBeenCalled();
    expect(imap.peekText).not.toHaveBeenCalled();
  });

  it('calls peekText when include_body is true and still never getEmail', async () => {
    const imap = mockImap();
    imap.peekText.mockResolvedValue('plain body');
    const arrival = await MailArrival.tryCreate({
      config: systemOneConfig({ includeBody: true }),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });

    if (!arrival) throw new Error('expected MailArrival instance');

    await arrival.handle({
      account: 'personal',
      mailbox: 'INBOX',
      meta: {
        id: '10',
        subject: 'Invoice',
        from: { address: 'billing@example.com' },
        to: [{ address: 'me@example.com' }],
        date: '2026-09-21T00:00:00.000Z',
        seen: false,
        flagged: false,
        answered: false,
        hasAttachments: false,
        labels: [],
      },
    });

    expect(imap.peekText).toHaveBeenCalledWith('personal', '10', 'INBOX');
    expect(imap.peekAttachments).toHaveBeenCalledWith('personal', '10', 'INBOX');
    expect(imap.getEmail).not.toHaveBeenCalled();
  });

  it('should pass peekAttachments names into systemOne state', async () => {
    const imap = mockImap();
    imap.peekAttachments.mockResolvedValue([{ filename: 'inv.pdf', mime: 'application/pdf' }]);
    const arrival = await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    if (!arrival) throw new Error('expected MailArrival instance');

    await arrival.handle({
      account: 'personal',
      mailbox: 'INBOX',
      meta: {
        id: '10',
        subject: 'Invoice',
        from: { name: 'Billing', address: 'billing@example.com' },
        to: [{ address: 'me@example.com' }],
        date: '2026-09-21T00:00:00.000Z',
        seen: false,
        flagged: false,
        answered: false,
        hasAttachments: true,
        labels: [],
        messageId: '<mid@example.com>',
      },
    });

    const payload = systemOneMock.mock.calls[0]?.[0] as
      | { state?: { message?: { attachments?: unknown } } }
      | undefined;
    expect(payload?.state?.message?.attachments).toEqual([
      { filename: 'inv.pdf', mime: 'application/pdf' },
    ]);
    expect(imap.getEmail).not.toHaveBeenCalled();
  });
});
