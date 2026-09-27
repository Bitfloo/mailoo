import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { IConnectionManager } from '../connections/types.js';
import { mcpLog } from '../logging.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import { MAX_OUTGOING_ATTACHMENT_BYTES } from './outgoing-attachments.js';
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

    it('should reject an attachment path outside the working directory', async () => {
      const outside = path.join(os.tmpdir(), 'mailoo-outside-probe.txt');
      await expect(
        service.sendEmail('test', {
          to: ['a@example.com'],
          subject: 'Files',
          body: 'See attached',
          attachments: [{ path: outside }],
        }),
      ).rejects.toThrow(/not allowed/);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('should reject /etc/passwd as an attachment path', async () => {
      await expect(
        service.sendEmail('test', {
          to: ['a@example.com'],
          subject: 'Files',
          body: 'See attached',
          attachments: [{ path: '/etc/passwd' }],
        }),
      ).rejects.toThrow(/not allowed/);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('should reject a ~/.ssh attachment path', async () => {
      await expect(
        service.sendEmail('test', {
          to: ['a@example.com'],
          subject: 'Files',
          body: 'See attached',
          attachments: [{ path: '~/.ssh/id_rsa' }],
        }),
      ).rejects.toThrow(/not allowed/);
      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('should reject a hidden attachment path under the working directory', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-out-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      try {
        const hidden = path.join(dir, '.ssh');
        await fs.mkdir(hidden);
        const key = path.join(hidden, 'id_rsa');
        await fs.writeFile(key, 'not-a-real-key');
        await expect(
          service.sendEmail('test', {
            to: ['a@example.com'],
            subject: 'Files',
            body: 'See attached',
            attachments: [{ path: key }],
          }),
        ).rejects.toThrow(/not allowed/);
        expect(transport.sendMail).not.toHaveBeenCalled();
      } finally {
        cwdSpy.mockRestore();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('should reject a symlink whose target leaves the working directory', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-out-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-secret-'));
      try {
        const secret = path.join(outside, 'secret.txt');
        await fs.writeFile(secret, 'outside-secret-marker');
        const link = path.join(dir, 'escape.txt');
        await fs.symlink(secret, link);
        await expect(
          service.sendEmail('test', {
            to: ['a@example.com'],
            subject: 'Files',
            body: 'See attached',
            attachments: [{ path: link }],
          }),
        ).rejects.toThrow(/not allowed/);
        expect(transport.sendMail).not.toHaveBeenCalled();
        const sent = JSON.stringify(transport.sendMail.mock.calls);
        expect(sent).not.toContain('outside-secret-marker');
      } finally {
        cwdSpy.mockRestore();
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('should read a symlink whose target stays inside the working directory', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-out-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      try {
        const target = path.join(dir, 'target.txt');
        await fs.writeFile(target, 'linked-body');
        const link = path.join(dir, 'link.txt');
        await fs.symlink(target, link);
        await service.sendEmail('test', {
          to: ['a@example.com'],
          subject: 'Files',
          body: 'See attached',
          attachments: [{ path: link }],
        });
        const mail = transport.sendMail.mock.calls[0][0];
        expect(mail.attachments).toEqual([
          {
            filename: 'link.txt',
            content: Buffer.from('linked-body'),
          },
        ]);
      } finally {
        cwdSpy.mockRestore();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('should reject an http attachment path without fetching it', async () => {
      const hits: string[] = [];
      const server = http.createServer((req, res) => {
        hits.push(req.url ?? '');
        res.end('remote-secret');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const { port } = server.address() as AddressInfo;
      try {
        await expect(
          service.sendEmail('test', {
            to: ['a@example.com'],
            subject: 'Files',
            body: 'See attached',
            attachments: [{ path: `http://127.0.0.1:${port}/secret` }],
          }),
        ).rejects.toThrow(/local file/);
        expect(transport.sendMail).not.toHaveBeenCalled();
        expect(hits).toEqual([]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });

    it('should reject a file URL attachment path', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-out-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      try {
        const file = path.join(dir, 'note.txt');
        await fs.writeFile(file, 'local-bytes');
        await expect(
          service.sendEmail('test', {
            to: ['a@example.com'],
            subject: 'Files',
            body: 'See attached',
            attachments: [{ path: `file://${file}` }],
          }),
        ).rejects.toThrow(/local file/);
        expect(transport.sendMail).not.toHaveBeenCalled();
      } finally {
        cwdSpy.mockRestore();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('should reject an attachment file over the size limit', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-out-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      try {
        const file = path.join(dir, 'big.bin');
        const handle = await fs.open(file, 'w');
        await handle.truncate(MAX_OUTGOING_ATTACHMENT_BYTES + 1);
        await handle.close();
        await expect(
          service.sendEmail('test', {
            to: ['a@example.com'],
            subject: 'Files',
            body: 'See attached',
            attachments: [{ path: file }],
          }),
        ).rejects.toThrow(String(MAX_OUTGOING_ATTACHMENT_BYTES));
        expect(transport.sendMail).not.toHaveBeenCalled();
      } finally {
        cwdSpy.mockRestore();
        await fs.rm(dir, { recursive: true, force: true });
      }
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
