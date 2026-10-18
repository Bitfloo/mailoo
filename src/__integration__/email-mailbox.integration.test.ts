import type { TestServices } from './helpers/index.js';
import { buildTestAccount, createTestServices, TEST_ACCOUNT_NAME } from './helpers/index.js';

describe('Mailbox Management Operations', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // create_mailbox
  // ---------------------------------------------------------------------------

  describe('createMailbox', () => {
    it('should create a new mailbox folder', async () => {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'TestFolder');

      const mailboxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      const created = mailboxes.find((m) => m.path === 'TestFolder');
      expect(created).toBeDefined();

      // Cleanup
      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'TestFolder');
    });

    it('should create a nested mailbox folder', async () => {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Parent.Child');

      const mailboxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      const created = mailboxes.find((m) => m.path === 'Parent.Child' || m.path === 'Parent/Child');
      expect(created).toBeDefined();

      // Cleanup
      try {
        await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'Parent.Child');
      } catch {
        await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'Parent/Child');
      }
      // The server created the parent folder too; it outlives its child.
      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'Parent');
    });
  });

  // ---------------------------------------------------------------------------
  // rename_mailbox
  // ---------------------------------------------------------------------------

  describe('renameMailbox', () => {
    it('should rename a mailbox folder', async () => {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'OldName');

      await services.imapService.renameMailbox(TEST_ACCOUNT_NAME, 'OldName', 'NewName');

      const mailboxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      const oldExists = mailboxes.find((m) => m.path === 'OldName');
      const newExists = mailboxes.find((m) => m.path === 'NewName');

      expect(oldExists).toBeUndefined();
      expect(newExists).toBeDefined();

      // Cleanup
      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'NewName');
    });
  });

  // ---------------------------------------------------------------------------
  // delete_mailbox
  // ---------------------------------------------------------------------------

  describe('deleteMailbox', () => {
    it('should delete a mailbox folder', async () => {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'ToDelete');

      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'ToDelete');

      const mailboxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      const deleted = mailboxes.find((m) => m.path === 'ToDelete');
      expect(deleted).toBeUndefined();
    });

    it('should refuse to delete INBOX', async () => {
      await expect(services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'inbox')).rejects.toThrow(
        'INBOX cannot be deleted',
      );
    });

    // GreenMail advertises no SPECIAL-USE; imapflow assigns \Trash from the name,
    // the same path a server without RFC 6154 takes.
    it('should refuse to delete the Trash folder and keep it', async () => {
      const before = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      const createdHere = !before.some((m) => m.path === 'Trash');
      if (createdHere) {
        await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Trash');
      }

      try {
        await expect(
          services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, 'Trash'),
        ).rejects.toThrow(/special-use folder \(\\Trash\)/);
        const after = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
        expect(after.map((m) => m.path)).toContain('Trash');
      } finally {
        // Later files share this GreenMail account. deleteMailbox refuses Trash,
        // so the folder made here is removed on the IMAP client directly.
        if (createdHere) {
          const client = await services.connections.getImapClient(TEST_ACCOUNT_NAME);
          await client.mailboxDelete('Trash');
        }
      }
    });
  });
});
