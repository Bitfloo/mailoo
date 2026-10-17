import { buildEmailMeta } from './watcher.service.js';

describe('buildEmailMeta', () => {
  it('should take the message id from the envelope', () => {
    const meta = buildEmailMeta({
      uid: 9,
      envelope: {
        subject: 'Hello',
        messageId: '<id@example.com>',
        from: [{ name: 'Ada', address: 'ada@example.com' }],
        to: [{ address: 'bob@example.com' }],
        date: new Date('2026-01-02T00:00:00.000Z'),
      },
    });
    expect(meta).toMatchObject({ id: '9', subject: 'Hello', messageId: '<id@example.com>' });
  });
});
