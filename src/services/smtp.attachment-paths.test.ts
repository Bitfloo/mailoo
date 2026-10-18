import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type RateLimiter from '../safety/rate-limiter.js';
import {
  createMockConnectionManager,
  createMockImapService,
  createMockRateLimiter,
  createMockTransport,
} from '../test-support/smtp-harness.js';
import { MAX_OUTGOING_ATTACHMENT_BYTES } from './outgoing-attachments.js';
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
  });
});
