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

    // A \Noselect parent cannot be opened, and the server refuses STATUS on it.
    it('should list a folder whose STATUS fails with zero counts', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set() },
        { name: '[Gmail]', path: '[Gmail]', flags: new Set(['\\Noselect']) },
      ]);
      // imapflow's STATUS answer holds only the counts the query asked for.
      client.status.mockImplementation(
        async (path: string, query: { messages?: boolean; unseen?: boolean }) => {
          if (path === '[Gmail]') throw new Error('Command failed: NO [NONEXISTENT]');
          return {
            path,
            ...(query.messages ? { messages: 10 } : {}),
            ...(query.unseen ? { unseen: 3 } : {}),
          };
        },
      );

      const result = await service.listMailboxes('test');

      expect(result).toEqual([
        {
          name: 'INBOX',
          path: 'INBOX',
          specialUse: '\\Inbox',
          totalMessages: 10,
          unseenMessages: 3,
        },
        {
          name: '[Gmail]',
          path: '[Gmail]',
          specialUse: undefined,
          totalMessages: 0,
          unseenMessages: 0,
        },
      ]);
    });

    // imapflow throws only when LIST no longer shows the folder; for a listed one it resolves false.
    it('should list a folder whose STATUS resolves false with zero counts', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set() },
        { name: '[Gmail]', path: '[Gmail]', flags: new Set(['\\Noselect']) },
      ]);
      client.status.mockImplementation(async (path: string) => {
        if (path === '[Gmail]') return false;
        return { path, messages: 10, unseen: 3 };
      });

      const result = await service.listMailboxes('test');

      expect(result).toEqual([
        {
          name: 'INBOX',
          path: 'INBOX',
          specialUse: '\\Inbox',
          totalMessages: 10,
          unseenMessages: 3,
        },
        {
          name: '[Gmail]',
          path: '[Gmail]',
          specialUse: undefined,
          totalMessages: 0,
          unseenMessages: 0,
        },
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

  describe('findEmailFolder', () => {
    /** LIST rows that must not be searched sit between the real folders. */
    const folders = [
      { name: 'INBOX', path: 'INBOX', listed: true, specialUse: '\\Inbox', flags: new Set() },
      { name: 'Archive', path: 'Archive', listed: true, flags: new Set() },
      // LSUB-only: subscribed but no longer in LIST.
      { name: 'Old', path: 'Old', listed: false, flags: new Set() },
      { name: '[Gmail]', path: '[Gmail]', listed: true, flags: new Set(['\\Noselect']) },
      { name: 'All Mail', path: '[Gmail]/All Mail', listed: true, flags: new Set(['\\All']) },
      {
        name: 'Starred',
        path: '[Gmail]/Starred',
        listed: true,
        specialUse: '\\Flagged',
        flags: new Set(),
      },
      { name: 'Broken', path: 'Broken', listed: true, flags: new Set() },
      { name: 'Receipts', path: 'Receipts', listed: true, flags: new Set() },
    ];
    const holding = new Set(['Archive', 'Receipts', '[Gmail]/All Mail', '[Gmail]/Starred']);

    /** Answers a header SEARCH for the folder the last lock selected; returns the folders searched. */
    function searchBySelectedFolder(headers: string): string[] {
      const searched: string[] = [];
      let selected = '';
      client.fetchOne.mockResolvedValue({ uid: 9, headers: Buffer.from(headers) });
      client.list.mockResolvedValue(folders);
      client.getMailboxLock.mockImplementation(async (path: string) => {
        selected = path;
        return { release: client._releaseFn };
      });
      client.search.mockImplementation(async () => {
        searched.push(selected);
        if (selected === 'Broken') throw new Error('Command failed: NO [SERVERBUG]');
        return holding.has(selected) ? [5] : [];
      });
      return searched;
    }

    const headers = 'Subject: Invoice\r\nMessage-ID:   <abc@example.com>  \r\n\r\n';

    it('should return the trimmed Message-ID and each real folder that holds it', async () => {
      searchBySelectedFolder(headers);

      const result = await service.findEmailFolder('test', '9', 'INBOX');

      expect(result).toEqual({ folders: ['Archive', 'Receipts'], messageId: '<abc@example.com>' });
    });

    it('should skip unlisted, \\Noselect and virtual folders', async () => {
      const searched = searchBySelectedFolder(headers);

      await service.findEmailFolder('test', '9', 'INBOX');

      expect(searched).toEqual(['INBOX', 'Archive', 'Broken', 'Receipts']);
    });

    it.each([
      ['has no Message-ID header', 'Subject: Invoice\r\n\r\n'],
      ['is not in the mailbox', undefined],
    ])('should refuse when the message %s', async (_, messageHeaders) => {
      searchBySelectedFolder(messageHeaders ?? '');
      if (messageHeaders === undefined) client.fetchOne.mockResolvedValue(false);

      await expect(service.findEmailFolder('test', '9', 'INBOX')).rejects.toThrow(
        'Could not retrieve Message-ID for this email.',
      );
    });
  });
});
