import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { IConnectionManager } from '../connections/types.js';
import ImapService, { findTextMimeParts } from './imap.service.js';
import { MAILBOX_LOCK_TIMEOUT_MS } from './mailbox-lock.js';

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
    mailboxCreate: vi.fn().mockResolvedValue({ path: 'created', created: true }),
    mailboxRename: vi.fn().mockResolvedValue({ path: 'old', newPath: 'new' }),
    mailboxDelete: vi.fn().mockResolvedValue({ path: 'deleted' }),
    namespace: undefined as { prefix: string; delimiter: string } | undefined,
    _releaseFn: releaseFn,
  };
}

/** LIST of a Gmail account as imapflow returns it (SPECIAL-USE advertised). */
function gmailMailboxes() {
  return [
    { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
    { name: '[Gmail]', path: '[Gmail]', flags: new Set(['\\Noselect']) },
    { name: 'All Mail', path: '[Gmail]/All Mail', specialUse: '\\All', flags: new Set(['\\All']) },
    {
      name: 'Drafts',
      path: '[Gmail]/Drafts',
      specialUse: '\\Drafts',
      flags: new Set(['\\Drafts']),
    },
    // imapflow derives specialUse only for the roles it knows; \Important is not one.
    { name: 'Important', path: '[Gmail]/Important', flags: new Set(['\\Important']) },
    {
      name: 'Sent Mail',
      path: '[Gmail]/Sent Mail',
      specialUse: '\\Sent',
      flags: new Set(['\\Sent']),
    },
    { name: 'Spam', path: '[Gmail]/Spam', specialUse: '\\Junk', flags: new Set(['\\Junk']) },
    {
      name: 'Starred',
      path: '[Gmail]/Starred',
      specialUse: '\\Flagged',
      flags: new Set(['\\Flagged']),
    },
    { name: 'Trash', path: '[Gmail]/Trash', specialUse: '\\Trash', flags: new Set(['\\Trash']) },
    { name: 'Receipts', path: 'Receipts', flags: new Set<string>() },
  ];
}

/**
 * imapflow sends a range without { uid: true } as sequence numbers, and those
 * name another message once an earlier one is expunged.
 */
function requireUidRange(command: string, range: string, options?: { uid?: boolean }) {
  if (options?.uid !== true) {
    throw new Error(`${command}(${range}) sent a sequence number, not a UID`);
  }
}

/**
 * imapflow runs one command at a time per connection, and a FETCH holds the
 * connection until its iterator finishes. A command issued inside the loop
 * never starts; against a server the call hangs until the socket times out.
 * Here such a command rejects at once and is recorded, so the unit lane fails
 * without GreenMail. Configure the client's other mocks before calling this.
 */
function rejectCommandsDuringFetch(
  client: ReturnType<typeof createMockImapClient>,
  rows: Record<string, unknown>[],
) {
  const issuedDuringFetch: string[] = [];
  let fetchOpen = false;
  const commands = client as unknown as Record<string, (...args: unknown[]) => unknown>;
  const guard =
    (name: string, command: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      if (fetchOpen) {
        issuedDuringFetch.push(name);
        throw new Error(`${name} issued while a FETCH iterator is open`);
      }
      return command(...args);
    };
  [
    'download',
    'fetchOne',
    'search',
    'list',
    'status',
    'messageMove',
    'messageDelete',
    'messageFlagsAdd',
    'messageFlagsRemove',
    'append',
  ].forEach((name) => {
    commands[name] = guard(name, commands[name]);
  });
  // Only the rows in the requested UID set, as UID FETCH returns them.
  client.fetch.mockImplementation((range: unknown) => {
    const uids = new Set(String(range).split(',').map(Number));
    async function* openFetch() {
      fetchOpen = true;
      try {
        yield* rows.filter((row) => uids.has(row.uid as number));
      } finally {
        fetchOpen = false;
      }
    }
    return openFetch();
  });
  // imapflow's fetchAll drains fetch and returns the rows after the FETCH completes.
  commands.fetchAll = guard('fetchAll', async (...args: unknown[]) => {
    requireUidRange('fetchAll', String(args[0]), args[2] as { uid?: boolean } | undefined);
    const collected: unknown[] = [];
    for await (const row of client.fetch(...args)) collected.push(row);
    return collected;
  });
  return issuedDuringFetch;
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
  // Label strategy detection
  // -----------------------------------------------------------------------

  describe('label strategy detection', () => {
    // A cached rejection would fail every label tool on the account until restart.
    it('should detect the strategy again when the previous detection failed', async () => {
      client.list.mockRejectedValueOnce(new Error('LIST failed'));
      await expect(service.listLabels('test')).rejects.toThrow('LIST failed');

      await expect(service.listLabels('test')).resolves.toEqual([]);
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

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', {
        acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      });
      expect(client.messageMove).toHaveBeenCalledWith('42', 'Archive', { uid: true });
      expect(client._releaseFn).toHaveBeenCalled();
    });

    it('calls sanitizeMailboxName on inputs', async () => {
      client.list.mockResolvedValue([]);

      // Passing valid names — sanitize should pass them through without error
      await service.moveEmail('test', '1', 'INBOX', 'Sent');

      expect(client.messageMove).toHaveBeenCalledWith('1', 'Sent', { uid: true });
    });

    it('should reject when the server refuses the move', async () => {
      client.messageMove.mockResolvedValue(false);

      await expect(service.moveEmail('test', '42', 'INBOX', 'Archive')).rejects.toThrow(
        'IMAP server rejected the move from "INBOX" to "Archive".',
      );
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

    // The folder names differ from the 'Trash' fallback, so a lookup that
    // ignores the \\Trash role cannot pass.
    it('should move to the Gmail \\Trash folder when permanent=false', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await service.deleteEmail('test', '99', 'INBOX', false);

      expect(client.messageMove).toHaveBeenCalledWith('99', '[Gmail]/Trash', { uid: true });
      expect(client.messageDelete).not.toHaveBeenCalled();
    });

    it('should move to INBOX.Trash on a server with the INBOX. namespace', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
        { name: 'Trash', path: 'INBOX.Trash', specialUse: '\\Trash', flags: new Set<string>() },
      ]);

      await service.deleteEmail('test', '99', 'INBOX', false);

      expect(client.messageMove).toHaveBeenCalledWith('99', 'INBOX.Trash', { uid: true });
    });

    it.each(['[Gmail]/All Mail', '[Gmail]/Starred'])(
      'should refuse to move to Trash from the virtual folder %s',
      async (mailbox) => {
        client.list.mockResolvedValue(gmailMailboxes());

        await expect(service.deleteEmail('test', '99', mailbox, false)).rejects.toThrow(
          /is a virtual folder/,
        );
        expect(client.messageMove).not.toHaveBeenCalled();
      },
    );

    it('should reject when the server refuses the move to Trash', async () => {
      client.list.mockResolvedValue(gmailMailboxes());
      client.messageMove.mockResolvedValue(false);

      await expect(service.deleteEmail('test', '99', 'INBOX', false)).rejects.toThrow(
        'IMAP server rejected the move to Trash.',
      );
    });
  });

  describe('bulkDelete', () => {
    it('should move every id to the \\Trash folder by default', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      const result = await service.bulkDelete('test', [3, 5], 'INBOX');

      expect(result).toEqual({ total: 2, succeeded: 2, failed: 0 });
      expect(client.messageMove).toHaveBeenCalledWith('3,5', '[Gmail]/Trash', { uid: true });
    });

    it('should never expunge by default', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await service.bulkDelete('test', [3, 5], 'INBOX');

      expect(client.messageDelete).not.toHaveBeenCalled();
    });

    it('should expunge every id when permanent=true', async () => {
      const result = await service.bulkDelete('test', [3, 5], 'INBOX', true);

      expect(result).toEqual({ total: 2, succeeded: 2, failed: 0 });
      expect(client.messageDelete).toHaveBeenCalledWith('3,5', { uid: true });
    });

    it('should refuse to move to Trash from a virtual folder', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await expect(service.bulkDelete('test', [3], '[Gmail]/All Mail')).rejects.toThrow(
        /is a virtual folder/,
      );
      expect(client.messageMove).not.toHaveBeenCalled();
    });

    it('should report every id failed when the server refuses the move to Trash', async () => {
      client.list.mockResolvedValue(gmailMailboxes());
      client.messageMove.mockResolvedValue(false);

      const result = await service.bulkDelete('test', [3, 5], 'INBOX');

      expect(result).toEqual({
        total: 2,
        succeeded: 0,
        failed: 2,
        errors: ['IMAP server rejected the move to Trash.'],
      });
    });
  });

  describe('bulkMove', () => {
    it('should move every id to the destination in one command', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      const result = await service.bulkMove('test', [3, 5], 'INBOX', 'Receipts');

      expect(result).toEqual({ total: 2, succeeded: 2, failed: 0 });
      expect(client.messageMove).toHaveBeenCalledWith('3,5', 'Receipts', { uid: true });
    });

    it('should report every id failed when the server refuses the move', async () => {
      client.messageMove.mockResolvedValue(false);

      const result = await service.bulkMove('test', [3, 5], 'INBOX', 'Receipts');

      expect(result).toEqual({
        total: 2,
        succeeded: 0,
        failed: 2,
        errors: ['IMAP server rejected the move operation.'],
      });
    });

    it('should report the server error when the move fails', async () => {
      client.messageMove.mockRejectedValue(new Error("Mailbox doesn't exist: Receipts"));

      const result = await service.bulkMove('test', [3, 5], 'INBOX', 'Receipts');

      expect(result).toEqual({
        total: 2,
        succeeded: 0,
        failed: 2,
        errors: ["Mailbox doesn't exist: Receipts"],
      });
    });

    it('should refuse to move out of a virtual folder', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await expect(service.bulkMove('test', [3], '[Gmail]/Starred', 'Receipts')).rejects.toThrow(
        /is a virtual folder/,
      );
      expect(client.messageMove).not.toHaveBeenCalled();
    });

    it('should release the mailbox lock when the move fails', async () => {
      client.messageMove.mockRejectedValue(new Error('connection lost'));

      await service.bulkMove('test', [3], 'INBOX', 'Receipts');

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('bulkSetFlags', () => {
    it.each([
      ['mark_read', 'messageFlagsAdd', '\\Seen'],
      ['mark_unread', 'messageFlagsRemove', '\\Seen'],
      ['flag', 'messageFlagsAdd', '\\Flagged'],
      ['unflag', 'messageFlagsRemove', '\\Flagged'],
    ] as const)('should apply %s with %s(%s) to every id', async (action, method, flag) => {
      const result = await service.bulkSetFlags('test', [3, 5], 'INBOX', action);

      expect(result).toEqual({ total: 2, succeeded: 2, failed: 0 });
      expect(client[method]).toHaveBeenCalledWith('3,5', [flag], { uid: true });
    });

    it('should report every id failed when the server refuses the flag change', async () => {
      client.messageFlagsAdd.mockResolvedValue(false);

      const result = await service.bulkSetFlags('test', [3, 5], 'INBOX', 'mark_read');

      expect(result).toEqual({
        total: 2,
        succeeded: 0,
        failed: 2,
        errors: ['IMAP server rejected the flag operation.'],
      });
    });
  });

  // A UID names a message only within the selected mailbox: a lock on INBOX
  // would move, flag or expunge the INBOX messages that carry these UIDs.
  describe('locked mailbox', () => {
    it.each<[string, (svc: ImapService) => Promise<unknown>]>([
      ['moveEmail', async (svc) => svc.moveEmail('test', '42', 'Archive', 'Receipts')],
      ['bulkSetFlags', async (svc) => svc.bulkSetFlags('test', [3, 5], 'Archive', 'flag')],
      ['bulkMove', async (svc) => svc.bulkMove('test', [3, 5], 'Archive', 'Receipts')],
      ['bulkDelete permanent', async (svc) => svc.bulkDelete('test', [3, 5], 'Archive', true)],
      ['getThread', async (svc) => svc.getThread('test', '<thread-1@example.test>', 'Archive')],
    ])('should lock the requested mailbox, not INBOX, for %s', async (_name, call) => {
      await call(service);

      expect(client.getMailboxLock.mock.calls).toEqual([
        ['Archive', { acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS }],
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Mailbox CRUD
  // -----------------------------------------------------------------------

  // DELETE or RENAME of INBOX or a special-use folder destroys or orphans the
  // mail the server and every other client file there.
  describe('deleteMailbox', () => {
    it.each(['INBOX', 'inbox', 'Inbox'])('should refuse to delete %s', async (name) => {
      client.list.mockResolvedValue(gmailMailboxes());

      await expect(service.deleteMailbox('test', name)).rejects.toThrow('INBOX cannot be deleted');
      expect(client.mailboxDelete).not.toHaveBeenCalled();
    });

    it.each([
      '[Gmail]/All Mail',
      '[Gmail]/Drafts',
      '[Gmail]/Important',
      '[Gmail]/Sent Mail',
      '[Gmail]/Spam',
      '[Gmail]/Starred',
      '[Gmail]/Trash',
    ])('should refuse to delete the special-use folder %s', async (name) => {
      client.list.mockResolvedValue(gmailMailboxes());

      await expect(service.deleteMailbox('test', name)).rejects.toThrow(/special-use folder/);
      expect(client.mailboxDelete).not.toHaveBeenCalled();
    });

    // RFC 6154 roles may arrive only as LIST flags (imapflow leaves specialUse unset then).
    it('should refuse to delete a folder whose LIST flags carry \\Archive', async () => {
      client.list.mockResolvedValue([
        { name: 'Archive', path: 'Archive', flags: new Set(['\\Archive']) },
      ]);

      await expect(service.deleteMailbox('test', 'Archive')).rejects.toThrow(/special-use folder/);
      expect(client.mailboxDelete).not.toHaveBeenCalled();
    });

    // A server without SPECIAL-USE sends no role flag; imapflow infers \Trash from the name.
    it('should refuse to delete a folder imapflow marks \\Trash by its name alone', async () => {
      client.list.mockResolvedValue([
        {
          name: 'Trash',
          path: 'Trash',
          flags: new Set(['\\HasNoChildren']),
          specialUse: '\\Trash',
          specialUseSource: 'name',
        },
      ]);

      await expect(service.deleteMailbox('test', 'Trash')).rejects.toThrow(/special-use folder/);
      expect(client.mailboxDelete).not.toHaveBeenCalled();
    });

    // Dovecot with a personal namespace "INBOX.": imapflow sends DELETE "INBOX.Trash" for "Trash".
    it('should refuse a special-use folder named without its namespace prefix', async () => {
      client.namespace = { prefix: 'INBOX.', delimiter: '.' };
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
        { name: 'Trash', path: 'INBOX.Trash', specialUse: '\\Trash', flags: new Set(['\\Trash']) },
      ]);

      await expect(service.deleteMailbox('test', 'Trash')).rejects.toThrow(/special-use folder/);
      expect(client.mailboxDelete).not.toHaveBeenCalled();
    });

    // A name that already carries the prefix must not be prefixed twice ("INBOX.INBOX.Trash").
    it('should refuse a special-use folder named with its namespace prefix', async () => {
      client.namespace = { prefix: 'INBOX.', delimiter: '.' };
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
        { name: 'Trash', path: 'INBOX.Trash', specialUse: '\\Trash', flags: new Set(['\\Trash']) },
      ]);

      await expect(service.deleteMailbox('test', 'INBOX.Trash')).rejects.toThrow(
        /special-use folder/,
      );
      expect(client.mailboxDelete).not.toHaveBeenCalled();
    });

    // LIST returns "[Gmail]/Trash"; a server that matches names without case would delete it.
    it('should refuse a special-use folder named in a different case', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await expect(service.deleteMailbox('test', '[gmail]/trash')).rejects.toThrow(
        /special-use folder/,
      );
      expect(client.mailboxDelete).not.toHaveBeenCalled();
    });

    it('should delete an ordinary folder', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await service.deleteMailbox('test', 'Receipts');

      expect(client.mailboxDelete).toHaveBeenCalledWith('Receipts');
    });
  });

  describe('renameMailbox', () => {
    it('should refuse to rename INBOX', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await expect(service.renameMailbox('test', 'inbox', 'Old Inbox')).rejects.toThrow(
        'INBOX cannot be renamed',
      );
      expect(client.mailboxRename).not.toHaveBeenCalled();
    });

    it('should refuse to rename a special-use folder', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await expect(service.renameMailbox('test', '[Gmail]/Sent Mail', 'Outbox')).rejects.toThrow(
        /special-use folder/,
      );
      expect(client.mailboxRename).not.toHaveBeenCalled();
    });

    it('should rename an ordinary folder', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await service.renameMailbox('test', 'Receipts', 'Receipts 2026');

      expect(client.mailboxRename).toHaveBeenCalledWith('Receipts', 'Receipts 2026');
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
      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', {
        readOnly: true,
        acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      });
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

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', {
        readOnly: true,
        acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      });
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

  describe('exportEmail', () => {
    // BODY.PEEK[] already avoids \Seen on GreenMail, so only this lock stops a
    // server that ignores PEEK from changing flags.
    it('should open the mailbox read-only (EXAMINE) before fetching the source', async () => {
      client.fetchOne.mockImplementation(async (_uid: string, query: { source?: unknown }) => {
        if (query.source) return { uid: 10, source: Buffer.from('raw') };
        return { uid: 10, size: 3 };
      });

      await service.exportEmail('test', '10', 'Archive', 1024);

      expect(client.getMailboxLock).toHaveBeenCalledWith('Archive', {
        readOnly: true,
        acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      });
      expect(client.getMailboxLock).toHaveBeenCalledTimes(1);
    });

    it('should report the UID as not found when the server returns no message', async () => {
      client.fetchOne.mockResolvedValue(false);

      await expect(service.exportEmail('test', '10', 'INBOX', 1024)).rejects.toThrow(
        'Email 10 not found in INBOX',
      );
    });

    it('should release the mailbox lock when the export fails', async () => {
      client.fetchOne.mockResolvedValue({ uid: 10, size: 99 });

      await expect(service.exportEmail('test', '10', 'INBOX', 10)).rejects.toThrow(/limit/);
      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });

  /** An attachment node as imapflow parses it from GreenMail BODYSTRUCTURE. */
  function attachmentNode(part: string, name: string, overrides: object = {}) {
    return {
      part,
      type: 'text/plain',
      parameters: { name },
      encoding: 'base64',
      size: 16,
      lineCount: 1,
      disposition: 'attachment',
      dispositionParameters: { filename: name },
      ...overrides,
    };
  }

  /** BODYSTRUCTURE GreenMail returns for a text body (part 1) followed by these attachments. */
  function mixedStructure(...attachments: object[]) {
    return {
      childNodes: [
        {
          part: '1',
          type: 'text/plain',
          parameters: { charset: 'utf-8' },
          encoding: '7bit',
          size: 28,
          lineCount: 1,
        },
        ...attachments,
      ],
      type: 'multipart/mixed',
      parameters: { boundary: '--_NmP-97144f485bd10a4e-Part_1' },
    };
  }

  /** BODYSTRUCTURE GreenMail returns for a text body plus two attachments (parts 2 and 3). */
  function twinAttachmentStructure(filename: string, secondFilename = filename) {
    return mixedStructure(attachmentNode('2', filename), attachmentNode('3', secondFilename));
  }

  /** The same structure with imapflow's part numbers removed at every depth. */
  function withoutPartNumbers(node: object): object {
    const { childNodes, ...fields } = node as { childNodes?: object[]; part?: string };
    delete fields.part;
    return childNodes ? { ...fields, childNodes: childNodes.map(withoutPartNumbers) } : fields;
  }

  /** client.fetchOne as imapflow answers a UID FETCH: false for a UID the mailbox does not hold. */
  function fetchOneByUid(message: { uid: number } & Record<string, unknown>) {
    client.fetchOne.mockImplementation(
      async (range: string, _query: unknown, options?: { uid?: boolean }) => {
        requireUidRange('fetchOne', range, options);
        return range === String(message.uid) ? message : false;
      },
    );
  }

  /** client.download as imapflow resolves it: decoded part content as a stream. */
  function downloadReturnsPartName() {
    client.download.mockImplementation(
      async (uid: string, part: string, options?: { uid?: boolean }) => {
        requireUidRange('download', uid, options);
        return {
          meta: { contentType: 'text/plain' },
          content: Readable.from([Buffer.from(`body-of-part-${part}`)]),
        };
      },
    );
  }

  describe('downloadAttachment', () => {
    it('should reject a filename two attachments share and list their MIME parts', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt'),
      });
      downloadReturnsPartName();

      await expect(service.downloadAttachment('test', '9', 'INBOX', 'a.txt')).rejects.toThrow(
        'Attachment name "a.txt" matches 2 attachments in email 9 (MIME parts 2, 3)',
      );
    });

    it('should download the MIME part of a filename that matches once', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt', 'b.txt'),
      });
      downloadReturnsPartName();

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-3');
    });

    // imapflow numbers every child part. A structure that arrives without those
    // numbers must be numbered the same way, or the download reads another part.
    it('should number attachment parts by position when the structure has none', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: withoutPartNumbers(twinAttachmentStructure('a.txt', 'b.txt')),
      });
      downloadReturnsPartName();

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-3');
    });

    it('should number a nested attachment by its dotted path when the structure has none', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: withoutPartNumbers({
          type: 'multipart/mixed',
          childNodes: [
            {
              type: 'multipart/related',
              childNodes: [
                { part: '1.1', type: 'text/html', encoding: '7bit', size: 40, lineCount: 1 },
                attachmentNode('1.2', 'logo.png', { type: 'image/png' }),
              ],
            },
            attachmentNode('2', 'terms.pdf', { type: 'application/pdf' }),
          ],
        }),
      });
      downloadReturnsPartName();

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'logo.png');

      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-1.2');
    });

    it('should refuse an attachment a byte over the size limit', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: mixedStructure(attachmentNode('2', 'big.txt', { size: 17 })),
      });
      downloadReturnsPartName();

      await expect(service.downloadAttachment('test', '9', 'INBOX', 'big.txt', 16)).rejects.toThrow(
        /exceeds/,
      );
    });

    it('should download an attachment exactly at the size limit', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: mixedStructure(attachmentNode('2', 'edge.txt', { size: 16 })),
      });
      downloadReturnsPartName();

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'edge.txt', 16);

      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-2');
    });

    // A lock left held makes every later call on the account wait out the lock timeout.
    it('should release the mailbox lock once after downloading', async () => {
      fetchOneByUid({ uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') });
      downloadReturnsPartName();

      await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveEmailAttachments', () => {
    let root: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-save-unit-'));
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('should write each same-named attachment to its own file', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt'),
      });
      downloadReturnsPartName();
      const destDir = path.join(root, 'out');

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);

      const contents = await Promise.all(saved.map(async (s) => fs.readFile(s.localPath, 'utf-8')));
      expect(contents.sort()).toEqual(['body-of-part-2', 'body-of-part-3']);
    });

    it.each([
      ['../../evil.txt', 'evil.txt'],
      ['..\\..\\evil.txt', 'evil.txt'],
      ['..', 'attachment'],
      ['.bashrc', 'bashrc'],
    ])('should keep attachment %j inside the destination as %j', async (filename, expected) => {
      const structure = twinAttachmentStructure(filename);
      structure.childNodes.pop();
      fetchOneByUid({ uid: 9, bodyStructure: structure });
      downloadReturnsPartName();
      const destDir = path.join(root, 'a', 'b');

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);

      expect(saved.map((s) => path.relative(destDir, s.localPath))).toEqual([expected]);
    });

    // The size is what was written, not the encoded BODYSTRUCTURE size (16 here).
    it('should return the filename, MIME type, written size and file URL', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: mixedStructure(attachmentNode('2', 'notes.txt')),
      });
      downloadReturnsPartName();
      const destDir = path.join(root, 'out');
      const localPath = path.join(destDir, 'notes.txt');

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);

      expect(saved).toEqual([
        {
          filename: 'notes.txt',
          localPath,
          fileUrl: `file://${localPath}`,
          mimeType: 'text/plain',
          size: 'body-of-part-2'.length,
        },
      ]);
    });

    it('should save an attachment at the size limit and skip one a byte over it', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'at-limit.txt', { size: 16 }),
          attachmentNode('3', 'over-limit.txt', { size: 17 }),
        ),
      });
      downloadReturnsPartName();

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root, 16);

      expect(saved.map((s) => s.filename)).toEqual(['at-limit.txt']);
    });

    // Calendar data goes to the calendar, not to the attachment folder. nodemailer
    // and Gmail attach invite.ics as application/ics; a text/calendar part may have any name.
    it('should not write an invite.ics or text/calendar attachment', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'notes.txt'),
          attachmentNode('3', 'invite.ics', { type: 'application/ics', size: 434 }),
          attachmentNode('4', 'meeting', { type: 'text/calendar' }),
        ),
      });
      downloadReturnsPartName();

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(saved.map((s) => s.filename)).toEqual(['notes.txt']);
    });

    it('should save the other attachments when one part fails to download', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt', 'b.txt'),
      });
      downloadReturnsPartName();
      const byPartName = client.download.getMockImplementation();
      client.download.mockImplementation(async (uid: string, part: string, options?: object) => {
        if (part === '2') throw new Error('Command failed: NO [UNAVAILABLE]');
        return byPartName?.(uid, part, options);
      });

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(saved.map((s) => s.filename)).toEqual(['b.txt']);
    });

    // APFS and NTFS are case-insensitive by default: "A.txt" would overwrite "a.txt".
    it.each([
      ['a.txt', 'A.txt', ['a.txt', 'A-2.txt']],
      ['A.txt', 'a.txt', ['A.txt', 'a-2.txt']],
    ])(
      'should give %s and then %s separate files though they differ only in case',
      async (first, second, expected) => {
        fetchOneByUid({ uid: 9, bodyStructure: twinAttachmentStructure(first, second) });
        downloadReturnsPartName();

        const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root);

        expect(saved.map((s) => path.basename(s.localPath))).toEqual(expected);
      },
    );

    // The arrival hook saves the attachments of every invite; one with nothing
    // else attached must not leave an empty folder behind.
    it('should not create the destination when no attachment qualifies', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'invite.ics', { type: 'application/ics', size: 434 }),
        ),
      });
      downloadReturnsPartName();
      const destDir = path.join(root, 'out');

      await service.saveEmailAttachments('test', '9', 'INBOX', destDir);

      await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('should issue no command while a FETCH is open', async () => {
      const message = { uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') };
      fetchOneByUid(message);
      downloadReturnsPartName();
      const issuedDuringFetch = rejectCommandsDuringFetch(client, [message]);

      await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(issuedDuringFetch).toEqual([]);
    });

    // A lock left held makes every later call on the account wait out the lock timeout.
    it('should release the mailbox lock once after saving', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt', 'b.txt'),
      });
      downloadReturnsPartName();

      await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCalendarParts', () => {
    const calendarPart = {
      type: 'text/calendar',
      parameters: { method: 'REQUEST', charset: 'utf-8' },
      encoding: '7bit',
      size: 316,
      lineCount: 13,
    };

    // Outlook sends a meeting request as a text/calendar alternative with no
    // .ics attachment. imapflow reports the type as "text/calendar", no subtype.
    it('should return an inline text/calendar alternative', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: {
          childNodes: [
            {
              part: '1',
              type: 'text/plain',
              parameters: { charset: 'utf-8' },
              encoding: '7bit',
              size: 10,
              lineCount: 1,
            },
            { part: '2', ...calendarPart },
          ],
          type: 'multipart/alternative',
          parameters: { boundary: '--_NmP-cd9bb8d05f86132d-Part_1' },
        },
      });
      downloadReturnsPartName();

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-2']);
    });

    // RFC 3501: a non-multipart message has only part 1; imapflow gives its root no part number.
    it('should read a message that is one text/calendar part as part 1', async () => {
      fetchOneByUid({ uid: 9, bodyStructure: calendarPart });
      downloadReturnsPartName();

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-1']);
    });

    // nodemailer and Gmail attach invite.ics as application/ics, not text/calendar.
    it('should return an invite.ics attachment typed application/ics', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'invite.ics', { type: 'application/ics', size: 434 }),
        ),
      });
      downloadReturnsPartName();

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-2']);
    });

    it('should number calendar parts by position when the structure has none', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: withoutPartNumbers(mixedStructure({ part: '2', ...calendarPart })),
      });
      downloadReturnsPartName();

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-2']);
    });

    it('should release the mailbox lock once after reading the parts', async () => {
      fetchOneByUid({ uid: 9, bodyStructure: mixedStructure({ part: '2', ...calendarPart }) });
      downloadReturnsPartName();

      await service.getCalendarParts('test', 'INBOX', '9');

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });

    it('should issue no command while a FETCH is open', async () => {
      const message = { uid: 9, bodyStructure: { part: '2', ...calendarPart } };
      fetchOneByUid(message);
      downloadReturnsPartName();
      const issuedDuringFetch = rejectCommandsDuringFetch(client, [message]);

      await service.getCalendarParts('test', 'INBOX', '9');

      expect(issuedDuringFetch).toEqual([]);
    });

    it('should read a text/calendar part attached as invite.ics once', async () => {
      fetchOneByUid({
        uid: 9,
        bodyStructure: {
          childNodes: [
            {
              part: '1',
              type: 'text/plain',
              parameters: { charset: 'utf-8' },
              encoding: '7bit',
              size: 10,
              lineCount: 1,
            },
            {
              part: '2',
              ...calendarPart,
              disposition: 'attachment',
              dispositionParameters: { filename: 'invite.ics' },
            },
          ],
          type: 'multipart/mixed',
          parameters: { boundary: '--_NmP-1fc051f5709d7b72-Part_1' },
        },
      });
      downloadReturnsPartName();

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-2']);
    });
  });

  describe('getThread', () => {
    /**
     * A GreenMail thread message as fetchAll returns it: one text/plain part
     * with a base64 body. A real server also reports In-Reply-To in the ENVELOPE.
     */
    function threadMessage(
      uid: number,
      references: string[],
      inReplyTo: string | null = references.at(-1) ?? null,
    ) {
      const messageId = `<thread-${uid}@example.test>`;
      const threadHeaders = [
        `Message-ID: ${messageId}`,
        ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
        ...(references.length > 0 ? [`References: ${references.join(' ')}`] : []),
      ];
      const headers = [
        ...threadHeaders,
        'Subject: Re: Thread',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
      ];
      const body = Buffer.from(`thread-body-${uid}`).toString('base64');
      return {
        seq: uid,
        uid,
        envelope: {
          date: new Date(Date.UTC(2026, 0, uid, 10)),
          subject: 'Re: Thread',
          from: [{ name: '', address: 'alice@example.test' }],
          to: [{ name: '', address: 'bob@example.test' }],
          messageId,
          inReplyTo: inReplyTo ?? undefined,
        },
        flags: new Set<string>(),
        bodyStructure: {
          type: 'text/plain',
          parameters: { charset: 'utf-8' },
          encoding: 'base64',
          size: 20,
          lineCount: 1,
        },
        source: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`),
        // BODY[HEADER.FIELDS (MESSAGE-ID REFERENCES IN-REPLY-TO)] as imapflow returns it.
        headers: Buffer.from(`${threadHeaders.join('\r\n')}\r\n\r\n`),
      };
    }

    /**
     * SEARCH HEADER matches a substring of the named header. Returns the
     * commands issued while a FETCH was open.
     */
    function serveThread(messages: ReturnType<typeof threadMessage>[]) {
      const headerOf = (message: (typeof messages)[number], name: string) =>
        message.source
          .toString()
          .split('\r\n')
          .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
          ?.slice(name.length + 1) ?? '';
      client.search.mockImplementation(
        async (query: { header: Record<string, string> }, options?: { uid?: boolean }) => {
          // Without { uid: true } SEARCH answers with sequence numbers.
          requireUidRange('search', JSON.stringify(query.header), options);
          const [[name, value]] = Object.entries(query.header);
          return messages.filter((m) => headerOf(m, name).includes(value)).map((m) => m.uid);
        },
      );
      client.download.mockImplementation(
        async (uid: string, _part: string, options?: { uid?: boolean }) => {
          requireUidRange('download', uid, options);
          return {
            meta: { contentType: 'text/plain' },
            content: Readable.from([Buffer.from(`thread-body-${uid}`)]),
          };
        },
      );
      return rejectCommandsDuringFetch(client, messages);
    }

    const thread = [
      threadMessage(1, []),
      threadMessage(2, ['<thread-1@example.test>']),
      threadMessage(3, ['<thread-1@example.test>', '<thread-2@example.test>']),
    ];

    it('should issue no command while the thread FETCH is open', async () => {
      const issuedDuringFetch = serveThread(thread);

      await service.getThread('test', '<thread-3@example.test>');

      expect(issuedDuringFetch).toEqual([]);
    });

    // A body read inside the FETCH loop fails; the message then keeps its base64 source text.
    it('should return every thread message with its decoded body', async () => {
      serveThread(thread);

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.messages.map((m) => m.bodyText)).toEqual([
        'thread-body-1',
        'thread-body-2',
        'thread-body-3',
      ]);
    });

    // Some clients set In-Reply-To and no References header on a reply. GreenMail
    // reports no In-Reply-To in the ENVELOPE, so only this lane reaches the case.
    it('should include the parent a reply names only in In-Reply-To', async () => {
      serveThread([threadMessage(1, []), threadMessage(2, [], '<thread-1@example.test>')]);

      const result = await service.getThread('test', '<thread-2@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual([
        '<thread-1@example.test>',
        '<thread-2@example.test>',
      ]);
    });

    // Each reply names only the message it answers, so the thread is one hop per message.
    const inReplyToChain = [
      threadMessage(1, []),
      threadMessage(2, [], '<thread-1@example.test>'),
      threadMessage(3, [], '<thread-2@example.test>'),
    ];
    const chainIds = [
      '<thread-1@example.test>',
      '<thread-2@example.test>',
      '<thread-3@example.test>',
    ];

    it('should find every reply of an In-Reply-To chain asked for by its root', async () => {
      serveThread(inReplyToChain);

      const result = await service.getThread('test', '<thread-1@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual(chainIds);
    });

    it('should find every parent of an In-Reply-To chain asked for by its newest reply', async () => {
      serveThread(inReplyToChain);

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual(chainIds);
    });

    it('should find the replies that name the root only in References', async () => {
      serveThread([
        threadMessage(1, []),
        threadMessage(2, ['<thread-1@example.test>'], null),
        threadMessage(3, ['<thread-1@example.test>', '<thread-2@example.test>'], null),
      ]);

      const result = await service.getThread('test', '<thread-1@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual(chainIds);
    });

    // Mail clients fold a References header longer than 78 characters (RFC 5322 2.2.3).
    it('should read ids from a folded References header', async () => {
      const folded = 'References: <x@example.test>\r\n <thread-2@example.test>';
      const reply = threadMessage(3, [], null);
      serveThread([
        threadMessage(2, [], null),
        {
          ...reply,
          source: Buffer.concat([Buffer.from(`${folded}\r\n`), reply.source]),
          headers: Buffer.from(`Message-ID: <thread-3@example.test>\r\n${folded}\r\n\r\n`),
        },
      ]);

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual([
        '<thread-2@example.test>',
        '<thread-3@example.test>',
      ]);
    });

    // A mailing-list thread can run to hundreds of messages, each fetched in full.
    it('should return at most 50 messages of a longer thread', async () => {
      const root = threadMessage(1, []);
      const replies = Array.from({ length: 59 }, (_, i) =>
        threadMessage(i + 2, ['<thread-1@example.test>']),
      );
      serveThread([root, ...replies]);

      const result = await service.getThread('test', '<thread-1@example.test>');

      expect(result.messages).toHaveLength(50);
    });

    it('should still find the thread when the server fails a References search', async () => {
      const { search } = client;
      serveThread(thread);
      const byHeader = search.getMockImplementation();
      search.mockImplementation(
        async (query: { header: Record<string, string> }, options?: { uid?: boolean }) => {
          if ('References' in query.header) throw new Error('Command failed: BAD');
          return byHeader?.(query, options);
        },
      );

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual(chainIds);
    });

    it('should release the mailbox lock once after reading the thread', async () => {
      serveThread(thread);

      await service.getThread('test', '<thread-3@example.test>');

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
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

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', {
        readOnly: true,
        acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      });
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

  // A single-message id is one canonical UID. These values are not, so
  // forwarding them selects a different set than the one message the caller named.
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
      ['exportEmail', async (svc) => svc.exportEmail('test', '1:*', 'INBOX', 1024)],
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
    ])(
      'should reject an id that is not one canonical UID from %s before contacting IMAP',
      async (_name, call) => {
        await expect(call(service)).rejects.toThrow(/positive integer UID/);
        expect(connections.getImapClient).not.toHaveBeenCalled();
      },
    );

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
      ['exportEmail', async (svc) => svc.exportEmail('test', '8', 'INBOX\r\nSent', 1024)],
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
      ['bulkSetFlags', async (svc) => svc.bulkSetFlags('test', [8], 'INBOX\r\nSent', 'flag')],
      ['bulkMove source', async (svc) => svc.bulkMove('test', [8], 'INBOX\nSent', 'Archive')],
      ['bulkMove destination', async (svc) => svc.bulkMove('test', [8], 'INBOX', 'Arch\r\nive')],
      ['bulkDelete', async (svc) => svc.bulkDelete('test', [8], 'INBOX\x00')],
      ['getThread', async (svc) => svc.getThread('test', '<m@example.com>', 'INBOX\r\nSent')],
      ['extractContacts', async (svc) => svc.extractContacts('test', { mailbox: 'IN\nBOX' })],
      ['getEmailStats', async (svc) => svc.getEmailStats('test', 'INBOX\x7F', 'week')],
      ['createMailbox', async (svc) => svc.createMailbox('test', 'Work\r\nProjects')],
      ['renameMailbox source', async (svc) => svc.renameMailbox('test', 'Old\nBox', 'New')],
      ['renameMailbox target', async (svc) => svc.renameMailbox('test', 'Old', 'New\x00Box')],
      ['deleteMailbox', async (svc) => svc.deleteMailbox('test', 'Old\r\nBox')],
    ])(
      'should reject a mailbox name with a control character from %s before contacting IMAP',
      async (_name, call) => {
        await expect(call(service)).rejects.toThrow(/control characters/);
        expect(connections.getImapClient).not.toHaveBeenCalled();
      },
    );

    // bulk_action takes any JSON integer; 0 or a negative id is not a UID, and
    // imapflow would send it inside the UID set as typed.
    it.each<[string, Call]>([
      ['bulkSetFlags zero', async (svc) => svc.bulkSetFlags('test', [5, 0], 'INBOX', 'flag')],
      ['bulkMove negative', async (svc) => svc.bulkMove('test', [-4], 'INBOX', 'Archive')],
      ['bulkDelete fraction', async (svc) => svc.bulkDelete('test', [1.5], 'INBOX')],
      ['bulkDelete above 2^32-1', async (svc) => svc.bulkDelete('test', [2 ** 32], 'INBOX', true)],
    ])(
      'should reject a bulk id that is not a UID from %s before contacting IMAP',
      async (_name, call) => {
        await expect(call(service)).rejects.toThrow(/positive integer UID/);
        expect(connections.getImapClient).not.toHaveBeenCalled();
      },
    );

    it('should reject a label with an empty or relative path segment before contacting IMAP', async () => {
      await expect(service.deleteLabel('test', '../Secret')).rejects.toThrow(/relative path/);
      expect(connections.getImapClient).not.toHaveBeenCalled();
    });
  });
});
