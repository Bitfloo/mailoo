/**
 * System flags are not keywords. imapflow would STORE "\Deleted" as the
 * IMAP flag, and a later EXPUNGE without UIDPLUS removes every such message.
 * Gmail system labels other than the allowlist move a message or change
 * its mailbox state.
 */

import type { ImapFlow } from 'imapflow';

import { detectLabelStrategy } from './label-strategy.js';

function mockClient(gmail: boolean) {
  return {
    list: vi.fn().mockResolvedValue([]),
    capabilities: new Set(gmail ? ['X-GM-EXT-1'] : []),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    mailbox: { permanentFlags: new Set(['\\*']) },
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    mailboxDelete: vi.fn().mockResolvedValue({ path: 'deleted' }),
  };
}

/** Gmail LIST: system folders carry RFC 6154 roles, user labels carry none. */
const GMAIL_LIST = [
  { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
  { name: 'Trash', path: '[Gmail]/Trash', specialUse: '\\Trash', flags: new Set(['\\Trash']) },
  {
    name: 'Sent Mail',
    path: '[Gmail]/Sent Mail',
    specialUse: '\\Sent',
    flags: new Set(['\\Sent']),
  },
  { name: 'Receipts', path: 'Receipts', flags: new Set<string>() },
];

async function keywordStrategy() {
  const client = mockClient(false);
  const strategy = await detectLabelStrategy(client as unknown as ImapFlow);
  expect(strategy.type).toBe('keyword');
  return { client, strategy };
}

async function gmailStrategy() {
  const client = mockClient(true);
  const strategy = await detectLabelStrategy(client as unknown as ImapFlow);
  expect(strategy.type).toBe('gmail');
  return { client, strategy };
}

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
