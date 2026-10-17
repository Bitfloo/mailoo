import {
  createMockConnectionManager,
  createMockImapClient,
  gmailMailboxes,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';

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
});
