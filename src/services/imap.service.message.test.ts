import {
  createMockConnectionManager,
  createMockImapClient,
  fetchOneByUid,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';

/** A message as imapflow fetches it for get_email: ENVELOPE, FLAGS, BODYSTRUCTURE and the source. */
function fetchedMessage(headerLines: string[], body: string, fields: object = {}) {
  return {
    uid: 10,
    envelope: {
      date: new Date('2026-03-02T09:00:00Z'),
      subject: 'Re: quarterly report',
      from: [{ name: 'Alice Example', address: 'alice@example.com' }],
      to: [{ address: 'bob@example.com' }],
      messageId: '<m3@example.com>',
    },
    flags: new Set<string>(),
    bodyStructure: { type: 'text/plain' },
    source: Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n${body}`),
    ...fields,
  };
}

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  describe('getEmail', () => {
    it('downloads leaf text parts rather than hardcoded part 1, and keeps Original Message', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        envelope: {
          subject: 'Hi',
          from: [{ address: 'a@example.com' }],
          to: [{ address: 'b@example.com' }],
          messageId: '<mid@example.com>',
        },
        flags: new Set(),
        bodyStructure: {
          type: 'multipart/alternative',
          part: '1',
          childNodes: [
            { type: 'text/plain', part: '1.1' },
            { type: 'text/html', part: '1.2' },
          ],
        },
        source: Buffer.from('From: a@example.com\r\n\r\nplaceholder-source'),
      });
      const quoted = 'Hello\n\n-----Original Message-----\nFrom: Bob\nHi';
      async function* chunksOf(text: string) {
        yield Buffer.from(text);
      }
      client.download.mockImplementation(async (_uid: string, part: string) => ({
        content: chunksOf(part === '1.1' ? quoted : '<p>Hello</p>'),
      }));

      const email = await service.getEmail('test', '10');
      const parts = client.download.mock.calls.map((call) => call[1]);
      expect(parts).toContain('1.1');
      expect(parts).toContain('1.2');
      expect(parts).not.toContain('1');
      expect(email.bodyText).toContain('-----Original Message-----');
    });

    // RFC 5322 folds a long header onto lines that start with white space. A reply
    // builds its References from this list, so a dropped line breaks the thread.
    it('should unfold a folded header before reading its value', async () => {
      fetchOneByUid(
        client,
        fetchedMessage(
          [
            'From: Alice Example <alice@example.com>',
            'Subject: Re: quarterly',
            '\treport',
            'Message-ID: <m3@example.com>',
            'References: <m1@example.com>',
            ' <m2@example.com>',
          ],
          'Hello',
        ),
      );

      const email = await service.getEmail('test', '10');

      expect([email.references, email.headers?.subject]).toEqual([
        ['<m1@example.com>', '<m2@example.com>'],
        'Re: quarterly report',
      ]);
    });
  });
});
