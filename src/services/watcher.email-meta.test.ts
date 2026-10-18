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

  it('should map every envelope and flag field of a fetched message', () => {
    const meta = buildEmailMeta({
      ...fetched,
      flags: new Set(['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '$Important']),
      envelope: {
        ...fetched.envelope,
        to: [{ name: 'Bob', address: 'bob@example.com' }, { address: 'carol@example.com' }],
      },
    });
    expect(meta).toEqual({
      id: '9',
      subject: 'Hello',
      from: { name: 'Ada', address: 'ada@example.com' },
      to: [{ name: 'Bob', address: 'bob@example.com' }, { address: 'carol@example.com' }],
      date: '2026-01-02T00:00:00.000Z',
      seen: true,
      flagged: true,
      answered: true,
      hasAttachments: false,
      labels: ['$Important'],
      messageId: '<id@example.com>',
    });
  });

  it("should name a message without a subject '(no subject)'", () => {
    const { subject, ...envelope } = fetched.envelope ?? {};
    expect(buildEmailMeta({ ...fetched, envelope }).subject).toBe('(no subject)');
  });

  it('should mark a message seen only when it carries \\Seen', () => {
    const read = buildEmailMeta({ ...fetched, flags: new Set(['\\Seen', '\\Flagged']) });
    const unread = buildEmailMeta({ ...fetched, flags: new Set() });
    expect([read.seen, unread.seen]).toEqual([true, false]);
  });

  it('should list no system flag as a label', () => {
    // Every system flag RFC 3501 defines, next to one user keyword.
    const systemFlags = ['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft', '\\Recent'];
    const meta = buildEmailMeta({ ...fetched, flags: new Set([...systemFlags, '$Important']) });
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
