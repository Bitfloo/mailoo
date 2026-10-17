import type { WatcherFetchMessage } from './watcher.service.js';
import { buildEmailMeta } from './watcher.service.js';

// The shape imapflow's fetch yields for `{ envelope, flags, bodyStructure }`.
const fetched: WatcherFetchMessage = {
  uid: 9,
  envelope: {
    subject: 'Hello',
    messageId: '<id@example.com>',
    from: [{ name: 'Ada', address: 'ada@example.com' }],
    to: [{ address: 'bob@example.com' }],
    date: new Date('2026-01-02T00:00:00.000Z'),
  },
};

const textPart = { part: '1', type: 'text/plain', encoding: 'quoted-printable', size: 120 };

describe('buildEmailMeta', () => {
  it('should take the message id from the envelope', () => {
    const meta = buildEmailMeta(fetched);
    expect(meta).toMatchObject({ id: '9', subject: 'Hello', messageId: '<id@example.com>' });
  });

  it('should mark a message seen only when it carries \\Seen', () => {
    const read = buildEmailMeta({ ...fetched, flags: new Set(['\\Seen', '\\Flagged']) });
    const unread = buildEmailMeta({ ...fetched, flags: new Set() });
    expect([read.seen, unread.seen]).toEqual([true, false]);
  });

  it('should list only user keywords as labels', () => {
    const meta = buildEmailMeta({ ...fetched, flags: new Set(['\\Seen', '$Important']) });
    expect(meta.labels).toEqual(['$Important']);
  });

  it('should detect an attachment nested in a multipart body', () => {
    const withPdf = buildEmailMeta({
      ...fetched,
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          textPart,
          {
            part: '2',
            type: 'application/pdf',
            disposition: 'attachment',
            dispositionParameters: { filename: 'invoice.pdf' },
            encoding: 'base64',
            size: 48_213,
          },
        ],
      },
    });
    const textOnly = buildEmailMeta({
      ...fetched,
      bodyStructure: { type: 'multipart/alternative', childNodes: [textPart] },
    });
    expect([withPdf.hasAttachments, textOnly.hasAttachments]).toEqual([true, false]);
  });
});
