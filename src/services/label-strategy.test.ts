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
  mockClient,
  protonStrategy,
  recordSelectedMailbox,
} from '../test-support/label-client-fake.js';
import { detectLabelStrategy } from './label-strategy.js';

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

  // client.mailbox describes whichever mailbox is selected; keywords are sampled from INBOX.
  it.each([
    [
      'keyword detection',
      async () => {
        const client = mockClient(false);
        return { client, call: async () => detectLabelStrategy(client as unknown as ImapFlow) };
      },
    ],
    [
      'keyword listLabels',
      async () => {
        const { client, strategy } = await keywordStrategy();
        return { client, call: async () => strategy.listLabels(client as unknown as ImapFlow) };
      },
    ],
  ])('should read PERMANENTFLAGS for %s while INBOX is selected', async (_, prepare) => {
    const { client, call } = await prepare();
    const { ranIn, selected } = recordSelectedMailbox(client);
    Object.defineProperty(client, 'mailbox', {
      get() {
        ranIn.push(selected());
        return { permanentFlags: new Set(['\\*']) };
      },
    });

    await call();

    expect(ranIn).toEqual(['INBOX']);
  });
});

describe('label strategy detection', () => {
  const labelsFolder = (path: string, flags: string[]) => ({
    name: 'Labels',
    path,
    flags: new Set(flags),
  });

  it.each([
    ['protonmail', 'Labels is \\Noselect', false, labelsFolder('Labels', ['\\Noselect'])],
    [
      'protonmail',
      'Labels is \\Noselect on a server with X-GM-EXT-1',
      true,
      labelsFolder('Labels', ['\\Noselect']),
    ],
    ['keyword', 'Labels is selectable', false, labelsFolder('Labels', [])],
    [
      'keyword',
      'only Folders/Labels is \\Noselect',
      false,
      labelsFolder('Folders/Labels', ['\\Noselect']),
    ],
  ])('should detect %s when %s', async (type, _, gmail, folder) => {
    const client = mockClient(gmail);
    client.list.mockResolvedValue([folder]);

    const strategy = await detectLabelStrategy(client as unknown as ImapFlow);

    expect(strategy.type).toBe(type);
  });
});

// A refused STORE resolves false in imapflow rather than throwing.
describe('label server refusals', () => {
  it.each([
    [
      'keyword',
      'addLabel',
      keywordStrategy,
      'messageFlagsAdd',
      'Server rejected adding keyword "Work".',
    ],
    [
      'keyword',
      'removeLabel',
      keywordStrategy,
      'messageFlagsRemove',
      'Server rejected removing keyword "Work".',
    ],
    ['Gmail', 'addLabel', gmailStrategy, 'messageFlagsAdd', 'Server rejected adding label "Work".'],
    [
      'Gmail',
      'removeLabel',
      gmailStrategy,
      'messageFlagsRemove',
      'Server rejected removing label "Work".',
    ],
  ] as const)(
    'should fail a %s %s the server refuses',
    async (_, method, setup, command, error) => {
      const { client, strategy } = await setup();
      client[command].mockResolvedValue(false);

      await expect(
        strategy[method](client as unknown as ImapFlow, '5', 'Archive', 'Work'),
      ).rejects.toThrow(error);
    },
  );
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

  it('should add an ordinary label that contains punctuation', async () => {
    const { client, strategy } = await keywordStrategy();

    await strategy.addLabel(client as unknown as ImapFlow, '4', 'INBOX', '$Receipts-2024');

    expect(client.messageFlagsAdd).toHaveBeenCalledWith('4', ['$Receipts-2024'], { uid: true });
  });

  // RFC 9051: a keyword is an atom. imapflow drops any other keyword without sending STORE.
  // One label per character an atom excludes: SP, the atom-specials, and anything past ASCII.
  const nonAtoms = ['My Tag', 'a(b', 'a)b', 'a{b', 'a%b', 'a*b', 'Bad"Tag', 'a\\b', 'a]b', 'Ważne'];
  it.each(
    (['addLabel', 'removeLabel'] as const).flatMap((method) =>
      nonAtoms.map((label) => [method, label] as const),
    ),
  )('should refuse in %s a keyword that is not an IMAP atom: %s', async (method, label) => {
    const { client, strategy } = await keywordStrategy();

    await expect(
      strategy[method](client as unknown as ImapFlow, '4', 'INBOX', label),
    ).rejects.toThrow(
      'IMAP keywords cannot contain spaces, non-ASCII characters or ( ) { % * " \\ ].',
    );
  });

  it('should list the PERMANENTFLAGS keywords but not the system flags', async () => {
    const { client, strategy } = await keywordStrategy();
    client.mailbox = {
      permanentFlags: new Set(['\\Answered', '\\Seen', '\\*', '$Forwarded', 'Work']),
    };

    const labels = await strategy.listLabels(client as unknown as ImapFlow);

    expect(labels).toEqual([
      { name: '$Forwarded', strategy: 'keyword' },
      { name: 'Work', strategy: 'keyword' },
    ]);
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

  it.each(['\\Inbox', '\\Important'])('should add the %s system label', async (label) => {
    const { client, strategy } = await gmailStrategy();

    await strategy.addLabel(client as unknown as ImapFlow, '4', 'INBOX', label);

    expect(client.messageFlagsAdd).toHaveBeenCalledWith('4', [label], {
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

  it('should create a label as a folder with the bare name', async () => {
    const { client, strategy } = await gmailStrategy();

    await strategy.createLabel(client as unknown as ImapFlow, 'Receipts');

    expect(client.mailboxCreate.mock.calls).toEqual([['Receipts']]);
  });

  // imapflow gives no role to [Gmail]/Important, and names a role from the folder
  // name alone, so a user label called Archive arrives as \Archive.
  it('should list only user labels, each named by its last path segment', async () => {
    const { client, strategy } = await gmailStrategy();
    client.list.mockResolvedValue([
      ...GMAIL_LIST,
      { name: '[Gmail]', path: '[Gmail]', flags: new Set(['\\Noselect']) },
      { name: 'Important', path: '[Gmail]/Important', flags: new Set(['\\Important']) },
      { name: 'Archive', path: 'Archive', specialUse: '\\Archive', flags: new Set<string>() },
      { name: 'Clients', path: 'Clients', flags: new Set(['\\Noselect']) },
      { name: 'Acme', path: 'Clients/Acme', flags: new Set<string>() },
    ]);

    const labels = await strategy.listLabels(client as unknown as ImapFlow);

    expect(labels).toEqual([
      { name: 'Receipts', path: 'Receipts', strategy: 'gmail' },
      { name: 'Acme', path: 'Clients/Acme', strategy: 'gmail' },
    ]);
  });
});
