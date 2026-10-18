import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  createMockConnectionManager,
  createMockImapClient,
  fetchOneByUid,
  gmailMailboxes,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';

/** LIST of a server without SPECIAL-USE whose only folder imapflow gives a role is INBOX. */
const inboxOnly = [
  { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
];

const draft = { to: ['a@example.com'], subject: 'Draft', body: 'Body' };

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  describe('appendSentMessage', () => {
    it('files the copy in the \\Sent SPECIAL-USE folder when no sent_mailbox is set', async () => {
      client.list.mockResolvedValue([{ name: 'Sent', path: 'Sent Items', specialUse: '\\Sent' }]);

      await service.appendSentMessage('test', Buffer.from('raw'));

      expect(client.append).toHaveBeenCalledWith('Sent Items', expect.any(Buffer), ['\\Seen']);
    });

    it("prefers the account's sent_mailbox over the client's SPECIAL-USE guess", async () => {
      connections.getAccount.mockReturnValue({
        name: 'test',
        email: 'test@example.com',
        username: 'test@example.com',
        sentMailbox: 'INBOX.Sent Messages',
        imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      });
      client.list.mockResolvedValue([
        { name: 'Sent', path: 'INBOX.INBOX.Sent', specialUse: '\\Sent' },
      ]);

      await service.appendSentMessage('test', Buffer.from('raw'));

      expect(client.append).toHaveBeenCalledWith('INBOX.Sent Messages', expect.any(Buffer), [
        '\\Seen',
      ]);
      expect(client.list).not.toHaveBeenCalled();
    });

    it('files the copy in Sent when no folder has the \\Sent role', async () => {
      client.list.mockResolvedValue(inboxOnly);

      await service.appendSentMessage('test', Buffer.from('raw'));

      expect(client.append).toHaveBeenCalledWith('Sent', expect.any(Buffer), ['\\Seen']);
    });
  });

  describe('saveDraft folder and flags', () => {
    it('should append the draft to the \\Drafts folder flagged \\Draft and \\Seen', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await service.saveDraft('test', draft);

      expect(client.append).toHaveBeenCalledWith('[Gmail]/Drafts', expect.any(Buffer), [
        '\\Draft',
        '\\Seen',
      ]);
    });

    it('should return the appended UID and Drafts when no folder has the \\Drafts role', async () => {
      client.list.mockResolvedValue(inboxOnly);

      const result = await service.saveDraft('test', draft);

      expect(result).toEqual({ id: 7, mailbox: 'Drafts' });
    });

    // A server without UIDPLUS reports no UID for an APPEND.
    it('should return id 0 when the server reports no UID for the draft', async () => {
      client.list.mockResolvedValue(gmailMailboxes());
      client.append.mockResolvedValue({ destination: '[Gmail]/Drafts' });

      const result = await service.saveDraft('test', draft);

      expect(result).toEqual({ id: 0, mailbox: '[Gmail]/Drafts' });
    });

    it('should write From with the full name, Cc, In-Reply-To and an HTML body into the draft', async () => {
      connections.getAccount.mockReturnValue({
        ...connections.getAccount('test'),
        fullName: 'Test User',
      });
      client.list.mockResolvedValue(gmailMailboxes());

      await service.saveDraft('test', {
        ...draft,
        cc: ['c@example.com', 'd@example.com'],
        body: '<p>Hi</p>',
        html: true,
        inReplyTo: '<parent@example.com>',
      });

      const raw = (client.append.mock.calls[0][1] as Buffer).toString('utf8');
      const header = (name: string) => new RegExp(`^${name}: ([^;\\r\\n]*)`, 'm').exec(raw)?.[1];
      expect({
        from: header('From'),
        cc: header('Cc'),
        inReplyTo: header('In-Reply-To'),
        contentType: header('Content-Type'),
      }).toEqual({
        from: 'Test User <test@example.com>',
        cc: 'c@example.com, d@example.com',
        inReplyTo: '<parent@example.com>',
        contentType: 'text/html',
      });
    });
  });

  describe('fetchDraft', () => {
    it.each([
      ['the \\Drafts folder', gmailMailboxes(), '[Gmail]/Drafts'],
      ['Drafts when no folder has the \\Drafts role', inboxOnly, 'Drafts'],
    ])('should read the draft from %s', async (_where, mailboxes, expected) => {
      client.list.mockResolvedValue(mailboxes);
      fetchOneByUid(client, {
        uid: 9,
        envelope: { subject: 'Draft', to: [{ address: 'a@example.com' }] },
        flags: new Set(['\\Draft']),
        source: Buffer.from('Subject: Draft\r\n\r\nBody'),
      });

      const result = await service.fetchDraft('test', 9);

      expect([result.mailbox, client.getMailboxLock.mock.calls[0][0]]).toEqual([
        expected,
        expected,
      ]);
    });
  });

  describe('deleteDraft', () => {
    // Without UID mode the server reads 9 as a sequence number, which names another message.
    it('should expunge the draft by UID', async () => {
      await service.deleteDraft('test', 9, 'Drafts');

      expect(client.messageDelete).toHaveBeenCalledWith('9', { uid: true });
    });
  });

  describe('saveDraft', () => {
    it('RFC-2047 encodes a non-ASCII subject', async () => {
      client.list.mockResolvedValue([{ name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts' }]);
      await service.saveDraft('test', {
        to: ['a@example.com'],
        subject: 'Ünïcode – Test',
        body: 'Body',
      });
      expect(client.append).toHaveBeenCalledOnce();
      const raw = client.append.mock.calls[0][1] as Buffer;
      expect(raw.toString('utf8')).toMatch(/Subject:\s*=\?UTF-8\?[BQ]\?/i);
    });

    it('should embed a draft attachment read from the working directory', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-out-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
      try {
        const file = path.join(dir, 'note.txt');
        await fs.writeFile(file, 'draft-file-marker');
        client.list.mockResolvedValue([{ name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts' }]);
        await service.saveDraft('test', {
          to: ['a@example.com'],
          subject: 'Draft',
          body: 'Body',
          attachments: [{ path: file, filename: 'note.txt' }],
        });
        const raw = client.append.mock.calls[0][1] as Buffer;
        const text = raw.toString('utf8');
        expect(text).toContain('note.txt');
        expect(text).toContain(Buffer.from('draft-file-marker').toString('base64'));
      } finally {
        cwdSpy.mockRestore();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('should reject a draft attachment outside the working directory', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-draft-outside-'));
      try {
        const file = path.join(outside, 'secret.txt');
        await fs.writeFile(file, 'draft-secret-marker');
        client.list.mockResolvedValue([{ name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts' }]);
        await expect(
          service.saveDraft('test', {
            to: ['a@example.com'],
            subject: 'Draft',
            body: 'Body',
            attachments: [{ path: file }],
          }),
        ).rejects.toThrow(/not allowed/);
        expect(client.append).not.toHaveBeenCalled();
        const appended = JSON.stringify(client.append.mock.calls);
        expect(appended).not.toContain('draft-secret-marker');
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('should reject an http attachment path when saving a draft', async () => {
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
        client.list.mockResolvedValue([{ name: 'Drafts', path: 'Drafts', specialUse: '\\Drafts' }]);
        await expect(
          service.saveDraft('test', {
            to: ['a@example.com'],
            subject: 'Draft',
            body: 'Body',
            attachments: [{ path: `http://127.0.0.1:${port}/secret` }],
          }),
        ).rejects.toThrow(/local file/);
        expect(client.append).not.toHaveBeenCalled();
        expect(hits).toEqual([]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });
});
