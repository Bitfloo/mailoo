import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import { MAX_OUTGOING_ATTACHMENT_BYTES } from './outgoing-attachments.js';
import SmtpService from './smtp.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

/** Shape ImapService.fetchDraft returns for a reply draft with a PDF in Gmail's Drafts. */
function replyDraft() {
  return {
    mailbox: '[Gmail]/Drafts',
    email: {
      id: '42',
      subject: 'Re: Contract follow-up',
      from: { name: 'Draft Author', address: 'test@example.com' },
      to: [{ name: 'Rita', address: 'recipient@example.com' }, { address: 'legal@example.com' }],
      cc: [{ address: 'manager@example.com' }, { address: 'archive@example.com' }],
      date: '2026-10-01T08:00:00.000Z',
      seen: true,
      flagged: false,
      answered: false,
      hasAttachments: true,
      labels: [],
      messageId: '<draft-42@example.com>',
      inReplyTo: '<orig-7@example.com>',
      references: ['<root-1@example.com>', '<orig-7@example.com>'],
      bodyText: 'Signed copy attached.',
      attachments: [{ filename: 'contract.pdf', mimeType: 'application/pdf', size: 9 }],
      headers: {},
    },
  };
}

describe('SmtpService.sendDraft', () => {
  const sendMail = vi.fn();
  let imap: {
    fetchDraft: ReturnType<typeof vi.fn>;
    downloadAttachment: ReturnType<typeof vi.fn>;
    deleteDraft: ReturnType<typeof vi.fn>;
    appendSentMessage: ReturnType<typeof vi.fn>;
  };
  let allowed: boolean;

  beforeEach(() => {
    allowed = true;
    sendMail.mockReset().mockResolvedValue({ messageId: '<sent-42@example.com>' });
    imap = {
      fetchDraft: vi.fn().mockResolvedValue(replyDraft()),
      downloadAttachment: vi.fn().mockResolvedValue({
        filename: 'contract.pdf',
        mimeType: 'application/pdf',
        size: 9,
        contentBase64: Buffer.from('%PDF-1.7\n').toString('base64'),
      }),
      deleteDraft: vi.fn().mockResolvedValue(undefined),
      appendSentMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  /** The configured account for `name`: "test", or a second account for any other name. */
  function account(name: string) {
    const [user, fullName] = name === 'test' ? ['test', 'Test User'] : ['other', 'Other Desk'];
    return {
      name: user,
      email: `${user}@example.com`,
      fullName,
      username: `${user}@example.com`,
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    };
  }

  const otherSendMail = vi.fn();

  function service(saveToSent = true): SmtpService {
    otherSendMail.mockReset().mockResolvedValue({ messageId: '<other@example.com>' });
    const connections = {
      getAccount: vi.fn(account),
      getAccountNames: vi.fn().mockReturnValue(['test', 'other']),
      getImapClient: vi.fn(),
      getSmtpTransport: vi.fn().mockImplementation(async (name: string) => ({
        sendMail: name === 'test' ? sendMail : otherSendMail,
      })),
      closeAll: vi.fn(),
    } satisfies IConnectionManager;
    const rateLimiter = { tryConsume: vi.fn(() => allowed) } as unknown as RateLimiter;
    return new SmtpService(connections, rateLimiter, imap as unknown as ImapService, saveToSent);
  }

  it('should send the draft recipients, subject, threading headers and text body', async () => {
    await service().sendDraft('test', 42);
    const mail = sendMail.mock.calls[0]?.[0];
    expect({
      from: mail.from,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      text: mail.text,
      html: mail.html,
    }).toEqual({
      from: '"Test User" <test@example.com>',
      to: 'recipient@example.com, legal@example.com',
      cc: 'manager@example.com, archive@example.com',
      subject: 'Re: Contract follow-up',
      inReplyTo: '<orig-7@example.com>',
      references: '<root-1@example.com> <orig-7@example.com>',
      text: 'Signed copy attached.',
      html: undefined,
    });
  });

  it('should send an HTML draft as html without a text part', async () => {
    const draft = replyDraft();
    imap.fetchDraft.mockResolvedValue({
      ...draft,
      email: { ...draft.email, bodyHtml: '<p>Signed copy attached.</p>' },
    });
    await service().sendDraft('test', 42);
    const mail = sendMail.mock.calls[0]?.[0];
    expect({ html: mail.html, text: mail.text }).toEqual({
      html: '<p>Signed copy attached.</p>',
      text: undefined,
    });
  });

  it('should pass the mailbox to fetchDraft', async () => {
    await service().sendDraft('test', 42, 'Entwürfe');
    expect(imap.fetchDraft.mock.calls).toEqual([['test', 42, 'Entwürfe']]);
  });

  it('should download each draft attachment from the Drafts folder the server reported, with the size limit', async () => {
    await service().sendDraft('test', 42);
    expect(imap.downloadAttachment.mock.calls).toEqual([
      ['test', '42', '[Gmail]/Drafts', 'contract.pdf', MAX_OUTGOING_ATTACHMENT_BYTES],
    ]);
  });

  it('should attach the downloaded files decoded from base64', async () => {
    await service().sendDraft('test', 42);
    expect(sendMail.mock.calls[0]?.[0].attachments).toEqual([
      {
        filename: 'contract.pdf',
        content: Buffer.from('%PDF-1.7\n'),
        contentType: 'application/pdf',
      },
    ]);
  });

  it('should refuse a draft send over the rate limit before fetching the draft', async () => {
    allowed = false;
    const error = await service()
      .sendDraft('test', 42)
      .then(
        () => 'sent',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    expect({ error, fetches: imap.fetchDraft.mock.calls.length }).toEqual({
      error: 'Rate limit exceeded for account "test". Please wait before sending more emails.',
      fetches: 0,
    });
  });

  it('should send from the draft account, through its transport, and file its Sent copy there', async () => {
    await service().sendDraft('test', 42);
    expect({
      from: sendMail.mock.calls[0]?.[0].from,
      otherSends: otherSendMail.mock.calls.length,
      sentCopyAccounts: imap.appendSentMessage.mock.calls.map(([name]) => name),
    }).toEqual({
      from: '"Test User" <test@example.com>',
      otherSends: 0,
      sentCopyAccounts: ['test'],
    });
  });

  it('should attach every draft attachment', async () => {
    const draft = replyDraft();
    const annex = { filename: 'annex.pdf', mimeType: 'application/pdf', size: 9 };
    imap.fetchDraft.mockResolvedValue({
      ...draft,
      email: { ...draft.email, attachments: [...draft.email.attachments, annex] },
    });
    imap.downloadAttachment.mockImplementation(async (...args: unknown[]) => ({
      filename: args[3],
      mimeType: 'application/pdf',
      size: 9,
      contentBase64: Buffer.from('%PDF-1.7\n').toString('base64'),
    }));
    await service().sendDraft('test', 42);
    expect(
      sendMail.mock.calls[0]?.[0].attachments.map((a: { filename: string }) => a.filename),
    ).toEqual(['contract.pdf', 'annex.pdf']);
  });

  it('should refuse local file and URL access in the sent mail', async () => {
    await service().sendDraft('test', 42);
    const mail = sendMail.mock.calls[0]?.[0];
    expect({ file: mail.disableFileAccess, url: mail.disableUrlAccess }).toEqual({
      file: true,
      url: true,
    });
  });

  it('should report an empty message id when the transport returns none', async () => {
    sendMail.mockResolvedValue({});
    const result = await service().sendDraft('test', 42);
    expect(result.messageId).toBe('');
  });

  it('should not append a Sent copy when save_to_sent is off', async () => {
    const result = await service(false).sendDraft('test', 42);
    expect({
      appended: imap.appendSentMessage.mock.calls,
      savedToSent: result.savedToSent,
    }).toEqual({ appended: [], savedToSent: true });
  });

  it("should report the caller's message id when the transport returns none", async () => {
    sendMail.mockResolvedValue({});
    const result = await service().sendEmail('test', {
      to: ['recipient@example.com'],
      subject: 'Contract follow-up',
      body: 'Signed copy attached.',
      messageId: '<stable-7@example.com>',
    });
    expect(result.messageId).toBe('<stable-7@example.com>');
  });
});
