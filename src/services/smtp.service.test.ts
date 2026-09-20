import type { IConnectionManager } from '../connections/types.js';
import { mcpLog } from '../logging.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

function createMockConnectionManager(mockTransport: ReturnType<typeof createMockTransport>) {
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
    getImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

function createMockImapService() {
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

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let imap: ReturnType<typeof createMockImapService>;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    imap = createMockImapService();
    service = new SmtpService(connections, rateLimiter, imap);
  });

  describe('sendEmail', () => {
    it('sends email via SMTP transport', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
        savedToSent: true,
      });
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Test User" <test@example.com>',
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'World',
        }),
      );
    });

    it('passes a caller-supplied messageId through to sendMail', async () => {
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
        messageId: '<stable-id@example.com>',
      });
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: '<stable-id@example.com>' }),
      );
    });

    it('attaches path/base64 files', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Files',
        body: 'See attached',
        attachments: [
          {
            filename: 'note.txt',
            base64: Buffer.from('hi').toString('base64'),
            contentType: 'text/plain',
          },
        ],
      });
      const mail = transport.sendMail.mock.calls[0][0];
      expect(mail.attachments).toEqual([
        expect.objectContaining({ filename: 'note.txt', contentType: 'text/plain' }),
      ]);
      expect(Buffer.isBuffer(mail.attachments[0].content)).toBe(true);
    });

    it('appends a Sent copy after a successful send', async () => {
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });
      expect(imap.appendSentMessage).toHaveBeenCalledOnce();
    });

    it('still sends when Sent APPEND fails and exposes savedToSent: false', async () => {
      (imap.appendSentMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('NO [OVERQUOTA]'),
      );
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World-should-not-be-logged',
      });
      expect(result.status).toBe('sent');
      expect(result.messageId).toBe('<test@example.com>');
      expect(result.savedToSent).toBe(false);
      expect(mcpLog).toHaveBeenCalledWith(
        'warning',
        'smtp',
        expect.stringContaining('NO [OVERQUOTA]'),
      );
      const logData = vi
        .mocked(mcpLog)
        .mock.calls.map((call) => String(call[2]))
        .join('\n');
      expect(logData).not.toContain('World-should-not-be-logged');
    });

    it('skips Sent append for Gmail SMTP', async () => {
      connections.getAccount.mockReturnValue({
        name: 'test',
        email: 'user@gmail.com',
        username: 'user@gmail.com',
        imap: { host: 'imap.gmail.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
        oauth2: { provider: 'google' },
      });
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });
      expect(imap.appendSentMessage).not.toHaveBeenCalled();
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, imap);

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('includes CC and BCC when provided', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: 'cc1@example.com, cc2@example.com',
          bcc: 'bcc@example.com',
        }),
      );
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.html).toBe('<h1>Hello</h1>');
      expect(call.text).toBeUndefined();
    });
  });

  describe('forwardEmail', () => {
    it('sends HTML when html=true instead of stuffing tags into text', async () => {
      await service.forwardEmail('test', {
        emailId: '1',
        to: ['ext@example.com'],
        html: true,
        body: '<p>Hallo</p>',
      });
      const mail = transport.sendMail.mock.calls[0][0];
      expect(mail.html).toContain('<p>Hallo</p>');
      expect(mail.html).toContain('Forwarded message');
      expect(mail.html).toContain('html original');
      expect(mail.text).toBeUndefined();
    });

    it('keeps the plain-text quote path when html is false', async () => {
      await service.forwardEmail('test', {
        emailId: '1',
        to: ['ext@example.com'],
        body: 'FYI',
      });
      const mail = transport.sendMail.mock.calls[0][0];
      expect(mail.text).toContain('FYI');
      expect(mail.text).toContain('---------- Forwarded message ----------');
      expect(mail.html).toBeUndefined();
    });
  });
});
