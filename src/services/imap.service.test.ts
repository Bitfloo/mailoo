import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import type { IConnectionManager } from '../connections/types.js';
import ImapService, { findTextMimeParts } from './imap.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockImapClient() {
  const releaseFn = vi.fn();
  return {
    usable: true,
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 5, unseen: 2 }),
    fetch: vi.fn().mockReturnValue((async function* fetchMock() {})()),
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    append: vi.fn().mockResolvedValue({ uid: 7 }),
    download: vi.fn(),
    fetchOne: vi.fn(),
    _releaseFn: releaseFn,
  };
}

function createMockConnectionManager(mockClient: ReturnType<typeof createMockImapClient>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn().mockResolvedValue(mockClient),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  // -----------------------------------------------------------------------
  // listMailboxes
  // -----------------------------------------------------------------------

  describe('listMailboxes', () => {
    it('returns mailbox list with message counts', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Sent', path: 'Sent', specialUse: '\\Sent' },
      ]);
      client.status.mockResolvedValue({ messages: 10, unseen: 3 });

      const result = await service.listMailboxes('test');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'INBOX',
        path: 'INBOX',
        specialUse: '\\Inbox',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(result[1]).toEqual({
        name: 'Sent',
        path: 'Sent',
        specialUse: '\\Sent',
        totalMessages: 10,
        unseenMessages: 3,
      });
      expect(client.status).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // moveEmail
  // -----------------------------------------------------------------------

  describe('moveEmail', () => {
    it('moves email between mailboxes', async () => {
      // assertRealMailbox calls client.list() internally
      client.list.mockResolvedValue([{ name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' }]);

      await service.moveEmail('test', '42', 'INBOX', 'Archive');

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
      expect(client.messageMove).toHaveBeenCalledWith('42', 'Archive', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('calls sanitizeMailboxName on inputs', async () => {
      client.list.mockResolvedValue([]);

      // Passing valid names — sanitize should pass them through without error
      await service.moveEmail('test', '1', 'INBOX', 'Sent');

      expect(client.messageMove).toHaveBeenCalledWith('1', 'Sent', { uid: true });
    });
  });

  // -----------------------------------------------------------------------
  // deleteEmail
  // -----------------------------------------------------------------------

  describe('deleteEmail', () => {
    it('permanently deletes when permanent=true', async () => {
      await service.deleteEmail('test', '99', 'INBOX', true);

      expect(client.messageDelete).toHaveBeenCalledWith('99', { uid: true });
      expect(client.messageMove).not.toHaveBeenCalled();
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('moves to trash when permanent=false', async () => {
      // assertRealMailbox + trash detection both call client.list()
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
        { name: 'Trash', path: 'Trash', specialUse: '\\Trash' },
      ]);

      await service.deleteEmail('test', '99', 'INBOX', false);

      expect(client.messageDelete).not.toHaveBeenCalled();
      expect(client.messageMove).toHaveBeenCalledWith('99', 'Trash', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // setFlags
  // -----------------------------------------------------------------------

  describe('setFlags', () => {
    it('adds Seen flag for read action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'read');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    });

    it('removes Seen flag for unread action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'unread');

      expect(client.messageFlagsRemove).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('adds Flagged flag for flag action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'flag');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Flagged'], { uid: true });
    });
  });

  describe('findTextMimeParts', () => {
    it('selects leaf 1.1/1.2 instead of container part 1', () => {
      const parts = findTextMimeParts({
        type: 'multipart/related',
        part: '1',
        childNodes: [
          {
            type: 'multipart/alternative',
            part: '1',
            childNodes: [
              { type: 'text/plain', part: '1.1' },
              { type: 'text/html', part: '1.2' },
            ],
          },
        ],
      });
      expect(parts).toEqual({ plain: '1.1', html: '1.2' });
    });

    it('skips attachment and message/rfc822 subtrees', () => {
      const parts = findTextMimeParts({
        type: 'multipart/mixed',
        childNodes: [
          { type: 'text/plain', part: '1' },
          { type: 'text/plain', part: '2', disposition: 'attachment' },
          { type: 'message/rfc822', part: '3', childNodes: [{ type: 'text/html', part: '3.1' }] },
        ],
      });
      expect(parts.plain).toBe('1');
      expect(parts.html).toBeUndefined();
    });
  });

  describe('peekText', () => {
    it('uses a readOnly lock and does not fetch source', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        bodyStructure: { type: 'text/plain', part: '1' },
      });
      async function* chunksOf(text: string) {
        yield Buffer.from(text);
      }
      client.download.mockResolvedValue({ content: chunksOf('hello') });

      const text = await service.peekText('test', '10', 'INBOX');

      expect(text).toBe('hello');
      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
      expect(client.fetchOne).toHaveBeenCalledWith(
        '10',
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      const query = client.fetchOne.mock.calls[0][1];
      expect(query).not.toHaveProperty('source');
    });
  });

  describe('peekAttachments', () => {
    it('uses a readOnly lock and does not fetch source', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        bodyStructure: { type: 'text/plain', part: '1' },
      });

      await service.peekAttachments('test', '10', 'INBOX');

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
      expect(client.fetchOne).toHaveBeenCalledWith(
        '10',
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      const query = client.fetchOne.mock.calls[0][1];
      expect(query).not.toHaveProperty('source');
    });

    it('should return attachment filename and mime from bodyStructure', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        bodyStructure: {
          type: 'multipart/mixed',
          childNodes: [
            { type: 'text/plain', part: '1' },
            {
              part: '2',
              type: 'application/pdf',
              disposition: 'attachment',
              dispositionParameters: { filename: 'inv.pdf' },
            },
          ],
        },
      });

      const attachments = await service.peekAttachments('test', '10', 'INBOX');

      expect(attachments).toEqual([{ filename: 'inv.pdf', mime: 'application/pdf' }]);
    });
  });

  describe('getEmail', () => {
    it('downloads leaf text parts rather than hardcoded part 1, and keeps Original Message', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        envelope: {
          subject: 'Hi',
          from: [{ address: 'a@example.com' }],
          to: [{ address: 'b@example.com' }],
          messageId: '<mid@example.com>',
        },
        flags: new Set(),
        bodyStructure: {
          type: 'multipart/alternative',
          part: '1',
          childNodes: [
            { type: 'text/plain', part: '1.1' },
            { type: 'text/html', part: '1.2' },
          ],
        },
        source: Buffer.from('From: a@example.com\r\n\r\nplaceholder-source'),
      });
      const quoted = 'Hello\n\n-----Original Message-----\nFrom: Bob\nHi';
      async function* chunksOf(text: string) {
        yield Buffer.from(text);
      }
      client.download.mockImplementation(async (_uid: string, part: string) => ({
        content: chunksOf(part === '1.1' ? quoted : '<p>Hello</p>'),
      }));

      const email = await service.getEmail('test', '10');
      const parts = client.download.mock.calls.map((call) => call[1]);
      expect(parts).toContain('1.1');
      expect(parts).toContain('1.2');
      expect(parts).not.toContain('1');
      expect(email.bodyText).toContain('-----Original Message-----');
    });
  });

  describe('listEmails ordering', () => {
    it('pages by date newest-first, not by UID', async () => {
      client.search.mockResolvedValue([1, 2]);
      const older = {
        uid: 2,
        envelope: { date: new Date('2020-01-01'), subject: 'old', from: [], to: [] },
        flags: new Set(),
      };
      const newer = {
        uid: 1,
        envelope: { date: new Date('2026-01-01'), subject: 'new', from: [], to: [] },
        flags: new Set(),
      };
      let fetchCalls = 0;
      client.fetch.mockImplementation(() => {
        fetchCalls += 1;
        const rows = fetchCalls === 1 ? [older, newer] : [newer];
        async function* fetchMock() {
          for (const row of rows) yield row;
        }
        return fetchMock();
      });

      const result = await service.listEmails('test', { pageSize: 1 });
      expect(result.items[0].subject).toBe('new');
      expect(result.items[0].id).toBe('1');
    });
  });

  describe('listEmails date criteria', () => {
    it('passes since and before to IMAP as Date values, not strings', async () => {
      client.search.mockResolvedValue([]);
      await service.listEmails('test', {
        since: '2026-01-01',
        before: '2026-02-01',
      });
      expect(client.search).toHaveBeenCalledWith(
        {
          since: new Date('2026-01-01'),
          before: new Date('2026-02-01'),
        },
        { uid: true },
      );
    });
  });

  describe('searchEmails', () => {
    it('passes since and before as IMAP Date values, not strings', async () => {
      client.search.mockResolvedValue([]);
      await service.searchEmails('test', 'invoice', {
        since: '2026-01-01',
        before: '2026-02-01',
      });
      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({
          since: new Date('2026-01-01'),
          before: new Date('2026-02-01'),
        }),
        { uid: true },
      );
    });
  });

  describe('getEmailSecurity', () => {
    const foldedAuthHeaders = [
      'From: Brand <noreply@brand.example>',
      'Reply-To: support@brand.example',
      'Return-Path: <bounce@mail.brand.example>',
      'Authentication-Results: mx.google.com;',
      '       spf=pass smtp.mailfrom=noreply@brand.example;',
      '       dkim=pass header.d=brand.example header.s=s1;',
      '       dkim=pass header.d=mailer.example;',
      '       dmarc=pass header.from=brand.example',
      'List-Unsubscribe: <https://brand.example/unsub?token=secret>',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      '',
    ].join('\r\n');

    it('parses fetched headers into SPF/DKIM/DMARC without returning unsubscribe URLs', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        envelope: {},
        headers: Buffer.from(foldedAuthHeaders),
      });

      const signals = await service.getEmailSecurity('test', '10', 'INBOX');

      expect(signals.uid).toBe('10');
      expect(signals.mailbox).toBe('INBOX');
      expect(signals.fromDomain).toBe('brand.example');
      expect(signals.spf).toBe('pass');
      expect(signals.dmarc).toBe('pass');
      expect(signals.dkim).toEqual([
        { result: 'pass', domain: 'brand.example' },
        { result: 'pass', domain: 'mailer.example' },
      ]);
      expect(signals.hasListUnsubscribe).toBe(true);
      expect(JSON.stringify(signals)).not.toContain('https://brand.example/unsub');
    });

    it('uses a readOnly lock and fetches headers without source', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        envelope: {},
        headers: Buffer.from('From: a@b.example\r\n\r\n'),
      });

      await service.getEmailSecurity('test', '10', 'INBOX');

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
      expect(client.fetchOne).toHaveBeenCalledWith(
        '10',
        { uid: true, envelope: true, headers: true },
        { uid: true },
      );
      expect(client.fetchOne.mock.calls[0][1]).not.toHaveProperty('source');
    });

    it('releases the mailbox lock when the message is missing', async () => {
      client.fetchOne.mockResolvedValue(false);

      await expect(service.getEmailSecurity('test', '99', 'INBOX')).rejects.toThrow(
        /Email 99 not found in INBOX/,
      );
      expect(client._releaseFn).toHaveBeenCalled();
    });
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
      const dir = await fs.mkdtemp(path.join(process.cwd(), 'tmp-mailoo-out-'));
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

  // A single-message id is one UID. These strings are sequence-sets or non-integers;
  // forwarding them selects more than the one message the caller named.
  describe('single-message inputs', () => {
    type Call = (svc: ImapService) => Promise<unknown>;

    it.each<[string, Call]>([
      ['getEmail', async (svc) => svc.getEmail('test', '1:*', 'INBOX')],
      ['getEmailFlags', async (svc) => svc.getEmailFlags('test', '1,2', 'INBOX')],
      ['moveEmail', async (svc) => svc.moveEmail('test', '1:5', 'INBOX', 'Archive')],
      ['deleteEmail', async (svc) => svc.deleteEmail('test', '*', 'INBOX', true)],
      ['setFlags', async (svc) => svc.setFlags('test', '0', 'INBOX', 'read')],
      ['addLabel', async (svc) => svc.addLabel('test', '-3', 'INBOX', 'Tag')],
      ['removeLabel', async (svc) => svc.removeLabel('test', '1.5', 'INBOX', 'Tag')],
      ['findEmailFolder', async (svc) => svc.findEmailFolder('test', '12abc', 'INBOX')],
      ['downloadAttachment', async (svc) => svc.downloadAttachment('test', '01', 'INBOX', 'a.txt')],
      ['getEmailSecurity', async (svc) => svc.getEmailSecurity('test', '1e2', 'INBOX')],
      ['peekText', async (svc) => svc.peekText('test', ' 4', 'INBOX')],
      ['peekAttachments', async (svc) => svc.peekAttachments('test', '$', 'INBOX')],
      [
        'saveEmailAttachments',
        async (svc) => svc.saveEmailAttachments('test', '1:*', 'INBOX', '/tmp/x'),
      ],
      ['getCalendarParts', async (svc) => svc.getCalendarParts('test', 'INBOX', '2,3')],
      ['fetchDraft', async (svc) => svc.fetchDraft('test', 0)],
      ['fetchDraft fraction', async (svc) => svc.fetchDraft('test', 1.5)],
      ['deleteDraft', async (svc) => svc.deleteDraft('test', -1, 'Drafts')],
    ])('should reject a non-integer UID from %s before contacting IMAP', async (_name, call) => {
      await expect(call(service)).rejects.toThrow(/positive integer UID/);
      expect(connections.getImapClient).not.toHaveBeenCalled();
    });

    it.each<[string, Call]>([
      ['getEmail', async (svc) => svc.getEmail('test', '8', 'INBOX\r\nSent')],
      ['getEmailFlags', async (svc) => svc.getEmailFlags('test', '8', 'IN\x00BOX')],
      ['moveEmail', async (svc) => svc.moveEmail('test', '8', 'INBOX\nSent', 'Archive')],
      ['deleteEmail', async (svc) => svc.deleteEmail('test', '8', 'INBOX\rTrash', true)],
      ['setFlags', async (svc) => svc.setFlags('test', '8', 'INBOX\x7F', 'read')],
      ['addLabel', async (svc) => svc.addLabel('test', '8', 'Box\r\nNext', 'Tag')],
      ['removeLabel', async (svc) => svc.removeLabel('test', '8', 'Box\nNext', 'Tag')],
      ['findEmailFolder', async (svc) => svc.findEmailFolder('test', '8', 'INBOX\r\nSent')],
      [
        'downloadAttachment',
        async (svc) => svc.downloadAttachment('test', '8', 'INBOX\nSent', 'a.txt'),
      ],
      ['getEmailSecurity', async (svc) => svc.getEmailSecurity('test', '8', 'INBOX\r\nSent')],
      ['peekText', async (svc) => svc.peekText('test', '8', 'INBOX\nSent')],
      ['peekAttachments', async (svc) => svc.peekAttachments('test', '8', 'INBOX\r\nSent')],
      [
        'saveEmailAttachments',
        async (svc) => svc.saveEmailAttachments('test', '8', 'INBOX\nSent', '/tmp/x'),
      ],
      ['getCalendarParts', async (svc) => svc.getCalendarParts('test', 'INBOX\r\nSent', '8')],
      ['deleteDraft', async (svc) => svc.deleteDraft('test', 8, 'Drafts\nOther')],
      ['fetchDraft', async (svc) => svc.fetchDraft('test', 8, 'Drafts\r\nOther')],
    ])('should reject a mailbox name with a control character from %s before contacting IMAP', async (_name, call) => {
      await expect(call(service)).rejects.toThrow(/control characters/);
      expect(connections.getImapClient).not.toHaveBeenCalled();
    });

    it('should reject a destination mailbox that contains a quote', async () => {
      await expect(service.moveEmail('test', '4', 'INBOX', 'Archive"')).rejects.toThrow(
        /IMAP special/,
      );
      expect(connections.getImapClient).not.toHaveBeenCalled();
    });

    it.each<[string, Call]>([
      ['addLabel', async (svc) => svc.addLabel('test', '8', 'INBOX', 'Bad"Tag')],
      ['removeLabel', async (svc) => svc.removeLabel('test', '8', 'INBOX', 'Bad\\Tag')],
      ['createLabel', async (svc) => svc.createLabel('test', 'Bad*Tag')],
      ['deleteLabel', async (svc) => svc.deleteLabel('test', '../Secret')],
      ['addLabel paren', async (svc) => svc.addLabel('test', '8', 'INBOX', 'Tag)')],
      ['addLabel system flag', async (svc) => svc.addLabel('test', '8', 'INBOX', '\\Seen')],
    ])('should reject an unsafe label from %s before contacting IMAP', async (_name, call) => {
      await expect(call(service)).rejects.toThrow(/IMAP special|relative path/);
      expect(connections.getImapClient).not.toHaveBeenCalled();
    });

    it('should reject an unknown flag action before contacting IMAP', async () => {
      await expect(service.setFlags('test', '4', 'INBOX', 'explode' as 'read')).rejects.toThrow(
        /flag action/,
      );
      expect(connections.getImapClient).not.toHaveBeenCalled();
    });
  });
});
