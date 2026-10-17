/**
 * System flags are not keywords. imapflow would STORE "\Deleted" as the
 * IMAP flag, and a later EXPUNGE without UIDPLUS removes every such message.
 * Gmail system labels other than the allowlist move a message or change
 * its mailbox state.
 */

import type { ImapFlow } from 'imapflow';

import {
  GMAIL_LIST,
  gmailStrategy,
  keywordStrategy,
  protonStrategy,
  recordSelectedMailbox,
} from '../test-support/label-client-fake.js';

describe('label strategy detection', () => {
  // A lock left held makes every later call on the account wait out the lock timeout.
  it('should release the INBOX lock it takes to read PERMANENTFLAGS', async () => {
    const { client } = await keywordStrategy();

    expect(client.releaseFn).toHaveBeenCalledTimes(1);
  });
});

// A UID names a message only within the selected mailbox, and imapflow
// selects it when the lock is taken: another mailbox would label another message.
describe('label mailbox selection', () => {
  it.each([
    ['keyword', 'addLabel', keywordStrategy],
    ['keyword', 'removeLabel', keywordStrategy],
    ['Gmail', 'addLabel', gmailStrategy],
    ['Gmail', 'removeLabel', gmailStrategy],
  ] as const)(
    'should run a %s %s while the message mailbox is selected',
    async (_, method, setup) => {
      const { client, strategy } = await setup();
      const { ranIn, record } = recordSelectedMailbox(client);
      client.messageFlagsAdd.mockImplementation(record(true));
      client.messageFlagsRemove.mockImplementation(record(true));

      await strategy[method](client as unknown as ImapFlow, '5', 'Archive', 'Work');

      expect(ranIn).toEqual(['Archive']);
    },
  );

  it('should copy a ProtonMail label from the message mailbox', async () => {
    const { client, strategy } = await protonStrategy();
    const { ranIn, record } = recordSelectedMailbox(client);
    client.messageCopy.mockImplementation(record({ path: 'Archive', destination: 'Labels/Work' }));

    await strategy.addLabel(client as unknown as ImapFlow, '5', 'Archive', 'Work');

    expect(ranIn).toEqual(['Archive']);
  });

  it('should read the Message-ID for a ProtonMail label removal in the message mailbox', async () => {
    const { client, strategy } = await protonStrategy();
    const { ranIn, record } = recordSelectedMailbox(client);
    client.fetchOne.mockImplementation(
      record({ uid: 5, envelope: { messageId: '<label-removal@example.test>' } }),
    );
    client.search.mockResolvedValue([12]);

    await strategy.removeLabel(client as unknown as ImapFlow, '5', 'Archive', 'Work');

    expect(ranIn).toEqual(['Archive']);
  });

  it('should delete a ProtonMail label copy in the label folder', async () => {
    const { client, strategy } = await protonStrategy();
    const { ranIn, record } = recordSelectedMailbox(client);
    client.fetchOne.mockResolvedValue({
      uid: 5,
      envelope: { messageId: '<label-removal@example.test>' },
    });
    client.search.mockImplementation(record([12]));
    client.messageDelete.mockImplementation(record(true));

    await strategy.removeLabel(client as unknown as ImapFlow, '5', 'Archive', 'Work');

    expect(ranIn).toEqual(['Labels/Work', 'Labels/Work']);
  });
});

describe('keyword labels', () => {
  it('should refuse to add a system flag and not store it', async () => {
    const { client, strategy } = await keywordStrategy();

    await expect(
      strategy.addLabel(client as unknown as ImapFlow, '4', 'INBOX', '\\Deleted'),
    ).rejects.toThrow('System flags are not labels; use mark_email.');
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('should refuse to remove a system flag and not remove it', async () => {
    const { client, strategy } = await keywordStrategy();

    await expect(
      strategy.removeLabel(client as unknown as ImapFlow, '4', 'INBOX', '\\Seen'),
    ).rejects.toThrow('System flags are not labels; use mark_email.');
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it('should add an ordinary label that contains parentheses', async () => {
    const { client, strategy } = await keywordStrategy();

    await strategy.addLabel(client as unknown as ImapFlow, '4', 'INBOX', 'Receipts (2024)');

    expect(client.messageFlagsAdd).toHaveBeenCalledWith('4', ['Receipts (2024)'], { uid: true });
  });
});

describe('Gmail labels', () => {
  it('should add the \\Starred system label', async () => {
    const { client, strategy } = await gmailStrategy();

    await strategy.addLabel(client as unknown as ImapFlow, '4', 'INBOX', '\\Starred');

    expect(client.messageFlagsAdd).toHaveBeenCalledWith('4', ['\\Starred'], {
      uid: true,
      useLabels: true,
    });
  });

  it('should refuse \\Trash', async () => {
    const { client, strategy } = await gmailStrategy();

    await expect(
      strategy.addLabel(client as unknown as ImapFlow, '4', 'INBOX', '\\Trash'),
    ).rejects.toThrow('Use move_email or delete_email for this.');
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('should remove the \\Starred system label', async () => {
    const { client, strategy } = await gmailStrategy();

    await strategy.removeLabel(client as unknown as ImapFlow, '4', 'INBOX', '\\Starred');

    expect(client.messageFlagsRemove).toHaveBeenCalledWith('4', ['\\Starred'], {
      uid: true,
      useLabels: true,
    });
  });

  it('should refuse to remove \\Trash', async () => {
    const { client, strategy } = await gmailStrategy();

    await expect(
      strategy.removeLabel(client as unknown as ImapFlow, '4', 'INBOX', '\\Trash'),
    ).rejects.toThrow('Use move_email or delete_email for this.');
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it('should add an ordinary label that contains parentheses', async () => {
    const { client, strategy } = await gmailStrategy();

    await strategy.addLabel(client as unknown as ImapFlow, '4', 'INBOX', 'Receipts (2024)');

    expect(client.messageFlagsAdd).toHaveBeenCalledWith('4', ['Receipts (2024)'], {
      uid: true,
      useLabels: true,
    });
  });

  // On Gmail a label is a folder: deleting [Gmail]/Trash or INBOX through
  // delete_label would remove a system folder, not a label.
  it.each([
    ['INBOX', 'INBOX cannot be deleted'],
    ['[Gmail]/Trash', /special-use folder/],
    ['[Gmail]/Sent Mail', /special-use folder/],
  ])('should refuse to delete %s as a label', async (name, error) => {
    const { client, strategy } = await gmailStrategy();
    client.list.mockResolvedValue(GMAIL_LIST);

    await expect(strategy.deleteLabel(client as unknown as ImapFlow, name)).rejects.toThrow(error);
    expect(client.mailboxDelete).not.toHaveBeenCalled();
  });

  it('should delete a user label', async () => {
    const { client, strategy } = await gmailStrategy();
    client.list.mockResolvedValue(GMAIL_LIST);

    await strategy.deleteLabel(client as unknown as ImapFlow, 'Receipts');

    expect(client.mailboxDelete).toHaveBeenCalledWith('Receipts');
  });
});
