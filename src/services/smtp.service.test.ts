import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type RateLimiter from '../safety/rate-limiter.js';
import {
  createMockConnectionManager,
  createMockImapService,
  createMockRateLimiter,
  createMockTransport,
} from '../test-support/smtp-harness.js';
import SmtpService from './smtp.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

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

    it('should build a Message-ID from the token and the account email domain', () => {
      const token = '6f1c2b8e-1d4a-4f7b-9c3e-2a5d8e7f0b1c';
      expect(service.messageIdFor('test', token)).toBe(`<${token}@example.com>`);
    });

    it('attaches decoded base64 content', async () => {
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
        {
          filename: 'note.txt',
          content: Buffer.from('hi'),
          contentType: 'text/plain',
        },
      ]);
    });

    it('reads a local file attachment and does not copy it from IMAP', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-out-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      try {
        const file = path.join(dir, 'note.txt');
        await fs.writeFile(file, 'hello-file');
        await service.sendEmail('test', {
          to: ['a@example.com'],
          subject: 'Files',
          body: 'See attached',
          attachments: [{ path: file, contentType: 'text/plain' }],
        });
        const mail = transport.sendMail.mock.calls[0][0];
        expect(mail.attachments).toEqual([
          {
            filename: 'note.txt',
            content: Buffer.from('hello-file'),
            contentType: 'text/plain',
          },
        ]);
        expect(imap.downloadAttachment).not.toHaveBeenCalled();
      } finally {
        cwdSpy.mockRestore();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('copies an existing message attachment by emailId and filename', async () => {
      (imap.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        filename: 'inv.pdf',
        mimeType: 'application/pdf',
        size: 4,
        contentBase64: Buffer.from('PDF!').toString('base64'),
      });
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Files',
        body: 'See attached',
        attachments: [{ emailId: '42', filename: 'inv.pdf', mailbox: 'Archive' }],
      });
      const mail = transport.sendMail.mock.calls[0][0];
      expect(mail.attachments).toEqual([
        {
          filename: 'inv.pdf',
          content: Buffer.from('PDF!'),
          contentType: 'application/pdf',
        },
      ]);
      expect(imap.downloadAttachment).toHaveBeenCalledWith(
        'test',
        '42',
        'Archive',
        'inv.pdf',
        50 * 1024 * 1024,
      );
    });

    it('defaults emailId attachment mailbox to INBOX', async () => {
      (imap.downloadAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        filename: 'a.bin',
        mimeType: 'application/octet-stream',
        size: 1,
        contentBase64: Buffer.from([0]).toString('base64'),
      });
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Files',
        body: 'See attached',
        attachments: [{ emailId: '7', filename: 'a.bin' }],
      });
      const mail = transport.sendMail.mock.calls[0][0];
      expect(mail.attachments[0]).toEqual({
        filename: 'a.bin',
        content: Buffer.from([0]),
        contentType: 'application/octet-stream',
      });
      expect(imap.downloadAttachment).toHaveBeenCalledWith(
        'test',
        '7',
        'INBOX',
        'a.bin',
        50 * 1024 * 1024,
      );
    });

    it('rejects an attachment that has neither path, base64, nor emailId+filename', async () => {
      await expect(
        service.sendEmail('test', {
          to: ['a@example.com'],
          subject: 'Files',
          body: 'See attached',
          attachments: [{ filename: 'orphan.txt', contentType: 'text/plain' }],
        }),
      ).rejects.toThrow(/path, base64, or emailId\+filename/);
      expect(transport.sendMail).not.toHaveBeenCalled();
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

    it('should reject an http attachment path when forwarding', async () => {
      await expect(
        service.forwardEmail('test', {
          emailId: '1',
          to: ['ext@example.com'],
          attachments: [{ path: 'https://example.com/secret.txt' }],
        }),
      ).rejects.toThrow(/local file/);
      expect(transport.sendMail).not.toHaveBeenCalled();
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
