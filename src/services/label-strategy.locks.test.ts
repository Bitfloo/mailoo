import type { ImapFlow } from 'imapflow';

import { keywordStrategy, protonStrategy } from '../test-support/label-client-fake.js';

// A lock left held makes every later call on the account wait out the lock timeout.
describe('label lock release', () => {
  it('should release the INBOX lock once after a keyword listLabels', async () => {
    const { client, strategy } = await keywordStrategy();
    client.releaseFn.mockClear();

    await strategy.listLabels(client as unknown as ImapFlow);

    expect(client.releaseFn).toHaveBeenCalledTimes(1);
  });

  it('should release the lock once after a ProtonMail addLabel', async () => {
    const { client, strategy } = await protonStrategy();
    client.releaseFn.mockClear();

    await strategy.addLabel(client as unknown as ImapFlow, '5', 'Archive', 'Work');

    expect(client.releaseFn).toHaveBeenCalledTimes(1);
  });

  it('should release both locks once after a ProtonMail removeLabel', async () => {
    const { client, strategy } = await protonStrategy();
    client.fetchOne.mockResolvedValue({
      uid: 5,
      envelope: { messageId: '<label-removal@example.test>' },
    });
    client.search.mockResolvedValue([12]);
    client.releaseFn.mockClear();

    await strategy.removeLabel(client as unknown as ImapFlow, '5', 'Archive', 'Work');

    expect(client.releaseFn).toHaveBeenCalledTimes(2);
  });
});
