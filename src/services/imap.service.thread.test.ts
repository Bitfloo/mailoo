import { Readable } from 'node:stream';

import {
  createMockConnectionManager,
  createMockImapClient,
  rejectCommandsDuringFetch,
  requireUidRange,
} from '../test-support/imap-client-fake.js';
import ImapService, { MAX_THREAD_MESSAGES } from './imap.service.js';

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  describe('getThread', () => {
    /**
     * A GreenMail thread message as fetchAll returns it: one text/plain part
     * with a base64 body. A real server also reports In-Reply-To in the ENVELOPE.
     */
    function threadMessage(
      uid: number,
      references: string[],
      inReplyTo: string | null = references.at(-1) ?? null,
    ) {
      const messageId = `<thread-${uid}@example.test>`;
      const threadHeaders = [
        `Message-ID: ${messageId}`,
        ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
        ...(references.length > 0 ? [`References: ${references.join(' ')}`] : []),
      ];
      const headers = [
        ...threadHeaders,
        'Subject: Re: Thread',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
      ];
      const body = Buffer.from(`thread-body-${uid}`).toString('base64');
      return {
        seq: uid,
        uid,
        envelope: {
          date: new Date(Date.UTC(2026, 0, uid, 10)),
          subject: 'Re: Thread',
          from: [{ name: '', address: 'alice@example.test' }],
          to: [{ name: '', address: 'bob@example.test' }],
          messageId,
          inReplyTo: inReplyTo ?? undefined,
        },
        flags: new Set<string>(),
        bodyStructure: {
          type: 'text/plain',
          parameters: { charset: 'utf-8' },
          encoding: 'base64',
          size: 20,
          lineCount: 1,
        },
        source: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`),
        // BODY[HEADER.FIELDS (MESSAGE-ID REFERENCES IN-REPLY-TO)] as imapflow returns it.
        headers: Buffer.from(`${threadHeaders.join('\r\n')}\r\n\r\n`),
      };
    }

    /**
     * SEARCH HEADER matches a substring of the named header. Returns the
     * commands issued while a FETCH was open.
     */
    function serveThread(messages: ReturnType<typeof threadMessage>[]) {
      const headerOf = (message: (typeof messages)[number], name: string) =>
        message.source
          .toString()
          .split('\r\n')
          .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
          ?.slice(name.length + 1) ?? '';
      client.search.mockImplementation(
        async (query: { header: Record<string, string> }, options?: { uid?: boolean }) => {
          // Without { uid: true } SEARCH answers with sequence numbers.
          requireUidRange('search', JSON.stringify(query.header), options);
          const [[name, value]] = Object.entries(query.header);
          return messages.filter((m) => headerOf(m, name).includes(value)).map((m) => m.uid);
        },
      );
      client.download.mockImplementation(
        async (uid: string, _part: string, options?: { uid?: boolean }) => {
          requireUidRange('download', uid, options);
          return {
            meta: { contentType: 'text/plain' },
            content: Readable.from([Buffer.from(`thread-body-${uid}`)]),
          };
        },
      );
      return rejectCommandsDuringFetch(client, messages);
    }

    const thread = [
      threadMessage(1, []),
      threadMessage(2, ['<thread-1@example.test>']),
      threadMessage(3, ['<thread-1@example.test>', '<thread-2@example.test>']),
    ];

    it('should issue no command while the thread FETCH is open', async () => {
      const issuedDuringFetch = serveThread(thread);

      await service.getThread('test', '<thread-3@example.test>');

      expect(issuedDuringFetch).toEqual([]);
    });

    // A body read inside the FETCH loop fails; the message then keeps its base64 source text.
    it('should return every thread message with its decoded body', async () => {
      serveThread(thread);

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.messages.map((m) => m.bodyText)).toEqual([
        'thread-body-1',
        'thread-body-2',
        'thread-body-3',
      ]);
    });

    // Some clients set In-Reply-To and no References header on a reply. GreenMail
    // reports no In-Reply-To in the ENVELOPE, so only this lane reaches the case.
    it('should include the parent a reply names only in In-Reply-To', async () => {
      serveThread([threadMessage(1, []), threadMessage(2, [], '<thread-1@example.test>')]);

      const result = await service.getThread('test', '<thread-2@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual([
        '<thread-1@example.test>',
        '<thread-2@example.test>',
      ]);
    });

    // Each reply names only the message it answers, so the thread is one hop per message.
    const inReplyToChain = [
      threadMessage(1, []),
      threadMessage(2, [], '<thread-1@example.test>'),
      threadMessage(3, [], '<thread-2@example.test>'),
    ];
    const chainIds = [
      '<thread-1@example.test>',
      '<thread-2@example.test>',
      '<thread-3@example.test>',
    ];

    it('should find every reply of an In-Reply-To chain asked for by its root', async () => {
      serveThread(inReplyToChain);

      const result = await service.getThread('test', '<thread-1@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual(chainIds);
    });

    it('should find every parent of an In-Reply-To chain asked for by its newest reply', async () => {
      serveThread(inReplyToChain);

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual(chainIds);
    });

    it('should find the replies that name the root only in References', async () => {
      serveThread([
        threadMessage(1, []),
        threadMessage(2, ['<thread-1@example.test>'], null),
        threadMessage(3, ['<thread-1@example.test>', '<thread-2@example.test>'], null),
      ]);

      const result = await service.getThread('test', '<thread-1@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual(chainIds);
    });

    // Mail clients fold a References header longer than 78 characters (RFC 5322 2.2.3).
    it('should read ids from a folded References header', async () => {
      const folded = 'References: <x@example.test>\r\n <thread-2@example.test>';
      const reply = threadMessage(3, [], null);
      serveThread([
        threadMessage(2, [], null),
        {
          ...reply,
          source: Buffer.concat([Buffer.from(`${folded}\r\n`), reply.source]),
          headers: Buffer.from(`Message-ID: <thread-3@example.test>\r\n${folded}\r\n\r\n`),
        },
      ]);

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual([
        '<thread-2@example.test>',
        '<thread-3@example.test>',
      ]);
    });

    // A mailing-list thread can run to hundreds of messages, each fetched in full.
    it('should return at most MAX_THREAD_MESSAGES messages of a longer thread', async () => {
      const root = threadMessage(1, []);
      const replies = Array.from({ length: MAX_THREAD_MESSAGES + 9 }, (_, i) =>
        threadMessage(i + 2, ['<thread-1@example.test>']),
      );
      serveThread([root, ...replies]);

      const result = await service.getThread('test', '<thread-1@example.test>');

      expect(result.messages).toHaveLength(MAX_THREAD_MESSAGES);
    });

    it('should still find the thread when the server fails a References search', async () => {
      const { search } = client;
      serveThread(thread);
      const byHeader = search.getMockImplementation();
      search.mockImplementation(
        async (query: { header: Record<string, string> }, options?: { uid?: boolean }) => {
          if ('References' in query.header) throw new Error('Command failed: BAD');
          return byHeader?.(query, options);
        },
      );

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual(chainIds);
    });

    // UIDs follow arrival in this mailbox: a message moved in later gets a
    // higher UID than a reply written after it.
    it('should order the thread by date, not by UID', async () => {
      const reply = threadMessage(1, ['<thread-2@example.test>']);
      serveThread([
        { ...reply, envelope: { ...reply.envelope, date: new Date(Date.UTC(2026, 0, 3, 10)) } },
        threadMessage(2, []),
      ]);

      const result = await service.getThread('test', '<thread-2@example.test>');

      expect(result.messages.map((m) => m.messageId)).toEqual([
        '<thread-2@example.test>',
        '<thread-1@example.test>',
      ]);
    });

    it('should count the messages it returns', async () => {
      serveThread(thread);

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.messageCount).toBe(3);
    });

    it('should return an empty thread when no message names the id', async () => {
      serveThread(thread);

      const result = await service.getThread('test', '<unknown@example.test>');

      expect(result).toEqual({
        threadId: '<unknown@example.test>',
        messages: [],
        participants: [],
        messageCount: 0,
      });
    });

    it('should return the Message-ID it was asked for as the thread id', async () => {
      serveThread(thread);

      const result = await service.getThread('test', '<thread-3@example.test>');

      expect(result.threadId).toBe('<thread-3@example.test>');
    });

    // A reply often writes an address in another case than the message it answers.
    it('should list each participant once, from From, To and Cc, ignoring case', async () => {
      const [first, reply] = [threadMessage(1, []), threadMessage(2, ['<thread-1@example.test>'])];
      const messages = [
        {
          ...first,
          envelope: { ...first.envelope, cc: [{ name: 'Carol', address: 'carol@example.test' }] },
        },
        {
          ...reply,
          envelope: {
            ...reply.envelope,
            from: [{ name: 'Bob', address: 'Bob@Example.test' }],
            to: [
              { name: '', address: 'ALICE@example.test' },
              { name: 'Dan', address: 'dan@example.test' },
            ],
            cc: [{ name: '', address: 'Carol@example.test' }],
          },
        },
      ];
      serveThread(messages);

      const result = await service.getThread('test', '<thread-1@example.test>');

      expect(result.participants).toEqual([
        { name: '', address: 'alice@example.test' },
        { name: '', address: 'bob@example.test' },
        { name: 'Carol', address: 'carol@example.test' },
        { name: 'Dan', address: 'dan@example.test' },
      ]);
    });

    it('should release the mailbox lock once after reading the thread', async () => {
      serveThread(thread);

      await service.getThread('test', '<thread-3@example.test>');

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });
});
