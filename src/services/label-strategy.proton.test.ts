import type { ImapFlow } from 'imapflow';

import type { LabelClient } from '../test-support/label-client-fake.js';
import { protonStrategy } from '../test-support/label-client-fake.js';

const MESSAGE = { uid: 5, envelope: { messageId: '<proton-label@example.test>' } };

/** The command answers only when its last argument asks for UID mode. */
function answersInUidModeOnly(
  client: LabelClient,
  command: 'messageCopy' | 'fetchOne' | 'search' | 'messageDelete',
  result: unknown,
) {
  client[command].mockImplementation(async (...args: unknown[]) => {
    if ((args.at(-1) as { uid?: boolean } | undefined)?.uid !== true) {
      throw new Error(`${command} sent without UID mode`);
    }
    return result;
  });
}

describe('ProtonMail labels', () => {
  // Bridge lists each label as a folder under a \Noselect "Labels" parent.
  it('should list only selectable Labels/ folders, without the prefix', async () => {
    const { client, strategy } = await protonStrategy();
    client.list.mockResolvedValue([
      { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
      { name: 'Labels', path: 'Labels', flags: new Set(['\\Noselect']) },
      { name: 'Work', path: 'Labels/Work', flags: new Set<string>() },
      { name: 'Old', path: 'Labels/Old', flags: new Set(['\\Noselect']) },
      { name: 'Labels-old', path: 'Labels-old', flags: new Set<string>() },
    ]);

    const labels = await strategy.listLabels(client as unknown as ImapFlow);

    expect(labels).toEqual([{ name: 'Work', path: 'Labels/Work', strategy: 'protonmail' }]);
  });

  it('should create a label as a folder under Labels/', async () => {
    const { client, strategy } = await protonStrategy();

    await strategy.createLabel(client as unknown as ImapFlow, 'Work');

    expect(client.mailboxCreate.mock.calls).toEqual([['Labels/Work']]);
  });

  it('should delete a label as its folder under Labels/', async () => {
    const { client, strategy } = await protonStrategy();

    await strategy.deleteLabel(client as unknown as ImapFlow, 'Work');

    expect(client.mailboxDelete.mock.calls).toEqual([['Labels/Work']]);
  });

  // Without UID mode the server reads the id as a sequence number: another message.
  it.each(['addLabel', 'removeLabel'] as const)(
    'should send every command of %s in UID mode',
    async (method) => {
      const { client, strategy } = await protonStrategy();
      answersInUidModeOnly(client, 'messageCopy', { path: 'Archive', destination: 'Labels/Work' });
      answersInUidModeOnly(client, 'fetchOne', MESSAGE);
      answersInUidModeOnly(client, 'search', [12]);
      answersInUidModeOnly(client, 'messageDelete', true);

      const call = strategy[method](client as unknown as ImapFlow, '5', 'Archive', 'Work');

      await expect(call).resolves.toBeUndefined();
    },
  );

  it('should fail adding a label when the server refuses the COPY', async () => {
    const { client, strategy } = await protonStrategy();
    client.messageCopy.mockResolvedValue(false);

    await expect(
      strategy.addLabel(client as unknown as ImapFlow, '5', 'Archive', 'Work'),
    ).rejects.toThrow('Server rejected adding label "Work" (COPY to Labels/Work failed).');
  });

  it.each([
    ['fetchOne finds no message', false, [12], 'Could not retrieve Message-ID'],
    [
      'the message has no Message-ID',
      { uid: 5, envelope: {} },
      [12],
      'Could not retrieve Message-ID',
    ],
    ['the label folder holds no copy', MESSAGE, [], 'Email not found in label "Work".'],
  ])('should fail removing a label when %s', async (_, message, found, error) => {
    const { client, strategy } = await protonStrategy();
    client.fetchOne.mockResolvedValue(message);
    client.search.mockResolvedValue(found);

    await expect(
      strategy.removeLabel(client as unknown as ImapFlow, '5', 'Archive', 'Work'),
    ).rejects.toThrow(error);
  });

  it('should fail removing a label when the server refuses to delete the copy', async () => {
    const { client, strategy } = await protonStrategy();
    client.fetchOne.mockResolvedValue(MESSAGE);
    client.search.mockResolvedValue([12]);
    client.messageDelete.mockResolvedValue(false);

    await expect(
      strategy.removeLabel(client as unknown as ImapFlow, '5', 'Archive', 'Work'),
    ).rejects.toThrow('Server rejected removing label "Work" for UID 12.');
  });
});
