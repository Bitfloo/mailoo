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
  });
});
