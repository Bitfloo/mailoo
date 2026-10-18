import {
  createMockConnectionManager,
  createMockImapClient,
  gmailMailboxes,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';
import { MAILBOX_LOCK_TIMEOUT_MS } from './mailbox-lock.js';

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
      expect(client._releaseFn).toHaveBeenCalledTimes(1);
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

    it('should refuse to move out of a virtual folder', async () => {
      client.list.mockResolvedValue(gmailMailboxes());

      await expect(service.moveEmail('test', '42', '[Gmail]/All Mail', 'Archive')).rejects.toThrow(
        /is a virtual folder/,
      );
      expect(client.messageMove).not.toHaveBeenCalled();
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
      expect(client._releaseFn).toHaveBeenCalledTimes(1);
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

    // imapflow gives a folder the \Trash role from its SPECIAL-USE flag or a known
    // name such as "Deleted Items"; a mailbox with neither has no \Trash folder.
    it('should move to Trash when no folder has the \\Trash role', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
      ]);

      await service.deleteEmail('test', '99', 'INBOX', false);

      expect(client.messageMove).toHaveBeenCalledWith('99', 'Trash', { uid: true });
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

    it('should move every id to Trash when no folder has the \\Trash role', async () => {
      client.list.mockResolvedValue([
        { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
      ]);

      await service.bulkDelete('test', [3, 5], 'INBOX');

      expect(client.messageMove).toHaveBeenCalledWith('3,5', 'Trash', { uid: true });
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

    it('should report every id failed when the server refuses the expunge', async () => {
      client.messageDelete.mockResolvedValue(false);

      const result = await service.bulkDelete('test', [3, 5], 'INBOX', true);

      expect(result).toEqual({
        total: 2,
        succeeded: 0,
        failed: 2,
        errors: ['IMAP server rejected the delete operation.'],
      });
    });

    it.each([
      ['an expunge', true, 'messageDelete'],
      ['a move to Trash', false, 'messageMove'],
    ] as const)('should report the server error when %s fails', async (_, permanent, command) => {
      client.list.mockResolvedValue(gmailMailboxes());
      client[command].mockRejectedValue(new Error('Command failed: NO [UNAVAILABLE]'));

      const result = await service.bulkDelete('test', [3, 5], 'INBOX', permanent);

      expect(result).toEqual({
        total: 2,
        succeeded: 0,
        failed: 2,
        errors: ['Command failed: NO [UNAVAILABLE]'],
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
});
