import { Readable } from 'node:stream';

import {
  createMockConnectionManager,
  createMockImapClient,
  fetchOneByUid,
  fetchServesRows,
  rejectCommandsDuringFetch,
} from '../test-support/imap-client-fake.js';
import ImapService, { extractReferences } from './imap.service.js';

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

    it('should key the headers in lower case with trimmed values', async () => {
      fetchOneByUid(client, fetchedMessage(['X-Mailer:   Example Mail  '], 'Hello'));

      const email = await service.getEmail('test', '10');

      expect(email.headers).toEqual({ 'x-mailer': 'Example Mail' });
    });

    it('should return the envelope Cc, Bcc, In-Reply-To and Message-ID', async () => {
      const message = fetchedMessage(['Subject: Re: quarterly report'], 'Hello');
      fetchOneByUid(client, {
        ...message,
        envelope: {
          ...message.envelope,
          cc: [{ name: 'Carol', address: 'carol@example.com' }],
          bcc: [{ address: 'dave@example.com' }],
          inReplyTo: '<m2@example.com>',
        },
      });

      const { cc, bcc, inReplyTo, messageId } = await service.getEmail('test', '10');

      expect({ cc, bcc, inReplyTo, messageId }).toEqual({
        cc: [{ name: 'Carol', address: 'carol@example.com' }],
        bcc: [{ name: undefined, address: 'dave@example.com' }],
        inReplyTo: '<m2@example.com>',
        messageId: '<m3@example.com>',
      });
    });

    it('should map the flags, keywords and a preview of the body', async () => {
      fetchOneByUid(
        client,
        fetchedMessage(['Subject: Re: quarterly report'], `Hello\r\n  there ${'x'.repeat(250)}`, {
          flags: new Set(['\\Seen', '\\Flagged', '$Work']),
        }),
      );

      const { seen, flagged, answered, labels, preview } = await service.getEmail('test', '10');

      expect({ seen, flagged, answered, labels, preview }).toEqual({
        seen: true,
        flagged: true,
        answered: false,
        labels: ['$Work'],
        preview: `Hello there ${'x'.repeat(250)}`.slice(0, 200),
      });
    });

    it('should fall back for a message with no subject and no sender', async () => {
      fetchOneByUid(client, { ...fetchedMessage([], 'Hello'), envelope: {} });

      const { subject, from, messageId } = await service.getEmail('test', '10');

      expect({ subject, from, messageId }).toEqual({
        subject: '(no subject)',
        from: { name: undefined, address: 'unknown' },
        messageId: '',
      });
    });

    // A failed part download leaves the body that the source itself carries.
    it('should keep the HTML body of a single-part message when its download fails', async () => {
      fetchOneByUid(
        client,
        fetchedMessage(['Content-Type: Text/HTML; charset=utf-8'], '<p>Hello</p>', {
          bodyStructure: { type: 'text/html' },
        }),
      );
      client.download.mockRejectedValue(new Error('Command failed: NO [UNAVAILABLE]'));

      const { bodyText, bodyHtml } = await service.getEmail('test', '10');

      expect({ bodyText, bodyHtml }).toEqual({ bodyText: undefined, bodyHtml: '<p>Hello</p>' });
    });

    it('should not return the raw multipart body when the part downloads fail', async () => {
      fetchOneByUid(
        client,
        fetchedMessage(
          ['Content-Type: multipart/alternative; boundary="b1"'],
          '--b1\r\nContent-Type: text/plain\r\n\r\nHello\r\n--b1--',
          {
            bodyStructure: {
              type: 'multipart/alternative',
              childNodes: [{ part: '1', type: 'text/plain' }],
            },
          },
        ),
      );
      client.download.mockRejectedValue(new Error('Command failed: NO [UNAVAILABLE]'));

      const { bodyText, bodyHtml } = await service.getEmail('test', '10');

      expect({ bodyText, bodyHtml }).toEqual({ bodyText: undefined, bodyHtml: undefined });
    });

    it('should return the downloaded HTML part of a multipart message', async () => {
      fetchOneByUid(
        client,
        fetchedMessage(['Content-Type: multipart/alternative; boundary="b1"'], '--b1--', {
          bodyStructure: {
            type: 'multipart/alternative',
            childNodes: [
              { part: '1', type: 'text/plain' },
              { part: '2', type: 'text/html' },
            ],
          },
        }),
      );
      client.download.mockImplementation(async (_uid: string, part: string) => ({
        content: Readable.from([Buffer.from(part === '2' ? '<p>Hello</p>' : 'Hello')]),
      }));

      const { bodyText, bodyHtml } = await service.getEmail('test', '10');

      expect({ bodyText, bodyHtml }).toEqual({ bodyText: 'Hello', bodyHtml: '<p>Hello</p>' });
    });
  });

  describe('listEmails', () => {
    it('should give each listed message its Message-ID', async () => {
      client.search.mockResolvedValue([10]);
      fetchServesRows(client, [fetchedMessage(['Subject: Re: quarterly report'], 'Hello')]);

      const { items } = await service.listEmails('test');

      expect(items.map((item) => item.messageId)).toEqual(['<m3@example.com>']);
    });
  });

  describe('a message whose Date header imapflow could not parse', () => {
    // imapflow yields the raw header text instead of a Date when the header does not parse.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function withUnparseableDate() {
      const message = fetchedMessage(['Subject: Re: quarterly report'], 'Hello');
      return {
        ...message,
        envelope: { ...message.envelope, date: 'Thursday, sometime last week' },
      };
    }

    it('should be listed dated when it was seen', async () => {
      client.search.mockResolvedValue([10]);
      fetchServesRows(client, [withUnparseableDate()]);

      const { items } = await service.listEmails('test');

      expect(items.map((item) => item.date)).toEqual(['2028-01-15T00:00:00.000Z']);
    });

    it('should be read dated when it was seen', async () => {
      fetchOneByUid(client, withUnparseableDate());

      const email = await service.getEmail('test', '10');

      expect(email.date).toBe('2028-01-15T00:00:00.000Z');
    });
  });

  describe('a message with no Date header', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // The server answers NIL for the date, so imapflow leaves it out of the envelope.
    function withoutDate() {
      const message = fetchedMessage(['Subject: Re: quarterly report'], 'Hello');
      const { date, ...envelope } = message.envelope;
      return { ...message, envelope };
    }

    it('should be listed dated when it was seen', async () => {
      client.search.mockResolvedValue([10]);
      fetchServesRows(client, [withoutDate()]);

      const { items } = await service.listEmails('test');

      expect(items.map((item) => item.date)).toEqual(['2028-01-15T00:00:00.000Z']);
    });

    it('should be read dated when it was seen', async () => {
      fetchOneByUid(client, withoutDate());

      const email = await service.getEmail('test', '10');

      expect(email.date).toBe('2028-01-15T00:00:00.000Z');
    });
  });

  describe('getEmail header fetch', () => {
    it('fetches headers instead of source: true when bodyStructure has text parts', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        envelope: {
          subject: 'No full source',
          from: [{ address: 'a@example.com' }],
          to: [{ address: 'b@example.com' }],
          messageId: '<mid@example.com>',
        },
        flags: new Set(),
        headers: Buffer.from(
          'References: <ref1@example.com>\r\n <ref2@example.com>\r\nContent-Type: text/plain\r\n\r\n',
        ),
        bodyStructure: { type: 'text/plain', part: '1' },
      });
      async function* chunksOf(text: string) {
        yield Buffer.from(text);
      }
      client.download.mockResolvedValue({ content: chunksOf('Selective body') });

      const email = await service.getEmail('test', '10');
      expect(client.fetchOne).toHaveBeenCalledTimes(1);
      expect(client.fetchOne).toHaveBeenCalledWith(
        '10',
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: ['references', 'in-reply-to', 'content-type'],
        },
        { uid: true },
      );
      expect(email.bodyText).toBe('Selective body');
      expect(email.references).toEqual(['<ref1@example.com>', '<ref2@example.com>']);
    });

    it('falls back to bounded 64KB source slice when bodyStructure has no text part', async () => {
      client.fetchOne
        .mockResolvedValueOnce({
          uid: 11,
          envelope: {
            subject: 'Fallback message',
            from: [{ address: 'a@example.com' }],
            to: [{ address: 'b@example.com' }],
            messageId: '<mid11@example.com>',
          },
          flags: new Set(),
          headers: Buffer.from('Content-Type: text/plain\r\n\r\n'),
          bodyStructure: { type: 'application/octet-stream', disposition: 'attachment' },
        })
        .mockResolvedValueOnce({
          uid: 11,
          source: Buffer.from('Content-Type: text/plain\r\n\r\nFallback body text'),
        });

      const email = await service.getEmail('test', '11');
      expect(client.fetchOne).toHaveBeenCalledTimes(2);
      expect(client.fetchOne).toHaveBeenNthCalledWith(
        2,
        '11',
        { uid: true, source: { start: 0, maxLength: 65536 } },
        { uid: true },
      );
      expect(email.bodyText).toBe('Fallback body text');
    });
  });

  describe('getEmail In-Reply-To', () => {
    // GreenMail, among others, leaves In-Reply-To out of ENVELOPE, so the header is the only source.
    it('should read In-Reply-To from the fetched headers when ENVELOPE has none', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        envelope: { subject: 'Re: plan', from: [], to: [], messageId: '<child@example.com>' },
        flags: new Set(),
        headers: Buffer.from('In-Reply-To: <parent@example.com>\r\n\r\n'),
        bodyStructure: { type: 'text/plain', part: '1' },
      });
      async function* chunksOf(text: string) {
        yield Buffer.from(text);
      }
      client.download.mockResolvedValue({ content: chunksOf('body') });

      const email = await service.getEmail('test', '10');

      expect({
        requested: client.fetchOne.mock.calls[0][1].headers,
        inReplyTo: email.inReplyTo,
        header: email.headers['in-reply-to'],
      }).toEqual({
        requested: ['references', 'in-reply-to', 'content-type'],
        inReplyTo: '<parent@example.com>',
        header: '<parent@example.com>',
      });
    });
  });

  describe('getEmails', () => {
    it('should download each body after the FETCH, not inside it', async () => {
      const row = (uid: number) => ({
        uid,
        envelope: {
          subject: `Message ${uid}`,
          from: [],
          to: [],
          messageId: `<m${uid}@example.com>`,
        },
        flags: new Set<string>(),
        bodyStructure: { type: 'text/plain', part: '1' },
      });
      async function* chunksOf(text: string) {
        yield Buffer.from(text);
      }
      client.download.mockImplementation(async (uid: string) => ({
        content: chunksOf(`body ${uid}`),
      }));
      const issuedDuringFetch = rejectCommandsDuringFetch(client, [row(7), row(8)]);

      const emails = await service.getEmails('test', ['7', '8']);

      expect({
        issuedDuringFetch,
        bodies: emails.map((email) => email.bodyText),
      }).toEqual({ issuedDuringFetch: [], bodies: ['body 7', 'body 8'] });
    });
  });

  describe('extractReferences', () => {
    it('extracts references from headers buffer and falls back to source', () => {
      expect(
        extractReferences({
          headers: Buffer.from('References: <a@ex.com>\r\n\t<b@ex.com>\r\n'),
        }),
      ).toEqual(['<a@ex.com>', '<b@ex.com>']);

      expect(
        extractReferences({
          source: Buffer.from('From: x@ex.com\r\nReferences: <c@ex.com> <d@ex.com>\r\n\r\nBody'),
        }),
      ).toEqual(['<c@ex.com>', '<d@ex.com>']);
    });
  });
});
