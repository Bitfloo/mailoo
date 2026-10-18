import {
  account,
  arrivalEmail,
  createArrival,
  mockImap,
  sdkAnswers,
  systemOneConfig,
  systemOneMock,
} from '../../test-support/mail-arrival-harness.js';
import type ImapService from '../imap.service.js';
import { MailArrival } from './index.js';

vi.mock(
  '@typesafe-ai/sdk',
  async () => (await import('../../test-support/mail-arrival-harness.js')).typesafeSdkStub,
);

vi.mock('../../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../safety/audit.js', () => ({
  default: { log: vi.fn().mockResolvedValue(undefined), AUDIT_LOG_PATH: '/tmp/mailoo-audit.log' },
}));

describe('MailArrival.handle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemOneMock.mockResolvedValue(sdkAnswers());
  });

  // Headers and the attachment list only: the body stays on the server while include_body is off.
  it('should not read the whole message', async () => {
    const imap = mockImap();
    await (await createArrival(imap)).handle(arrivalEmail('10'));
    expect({
      attachmentLists: imap.peekAttachments.mock.calls,
      bodies: imap.peekText.mock.calls.length,
      wholeMessages: imap.getEmail.mock.calls.length,
    }).toEqual({ attachmentLists: [['personal', '10', 'INBOX']], bodies: 0, wholeMessages: 0 });
  });

  it('should read the text part but not the whole message when include_body is true', async () => {
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

  it('should still classify a message when reading its text part fails', async () => {
    const imap = mockImap();
    imap.peekText.mockRejectedValue(new Error('FETCH failed'));
    const arrival = await createArrival(imap, { includeBody: true });
    expect(await arrival.handle(arrivalEmail('10'))).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: true,
    });
  });

  it('should still classify a message when listing its attachments fails', async () => {
    const imap = mockImap();
    imap.peekAttachments.mockRejectedValue(new Error('FETCH failed'));
    const arrival = await createArrival(imap);
    expect(await arrival.handle(arrivalEmail('10'))).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: true,
    });
  });

  it('should cut the body sent to System One at body_max_chars when include_body is true', async () => {
    const imap = mockImap();
    imap.peekText.mockResolvedValue('Your receipt is attached.');
    const arrival = await createArrival(imap, { includeBody: true, bodyMaxChars: 4 });
    await arrival.handle(arrivalEmail('10'));
    const payload = systemOneMock.mock.calls[0]?.[0] as
      | { state?: { message?: { body?: string } } }
      | undefined;
    expect(payload?.state?.message?.body).toBe('Your');
  });
});
