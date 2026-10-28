import { attachmentNode, mixedStructure } from '../test-support/imap-bodystructure.js';
import {
  createMockConnectionManager,
  createMockImapClient,
  fetchServesRows,
  requireUidRange,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';

/** A row of the ENVELOPE FETCH; a message without a Date header has no envelope date. */
function listedMessage(uid: number, date?: string, fields: object = {}) {
  return {
    uid,
    envelope: {
      ...(date ? { date: new Date(date) } : {}),
      subject: `Message ${uid}`,
      from: [],
      to: [],
    },
    flags: new Set<string>(),
    ...fields,
  };
}

interface ListOptions {
  page?: number;
  pageSize?: number;
  hasAttachment?: boolean;
}

type Lister = (svc: ImapService, options: ListOptions) => ReturnType<ImapService['listEmails']>;

/** listEmails and searchEmails share the paging, the date order and the attachment filter. */
const listers: [string, Lister][] = [
  ['listEmails', async (svc, options) => svc.listEmails('test', options)],
  ['searchEmails', async (svc, options) => svc.searchEmails('test', 'Message', options)],
];

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  describe('page order', () => {
    // Messages 1 and 3 share a date and message 2 has none: the tie goes to the
    // higher UID and the undated message sorts as the oldest, so the pages are 3,1 then 2.
    it.each(listers)(
      'should fetch the pages of %s newest first, undated last',
      async (_name, list) => {
        client.search.mockResolvedValue([1, 2, 3]);
        fetchServesRows(client, [
          listedMessage(1, '2026-03-01T10:00:00Z'),
          listedMessage(2),
          listedMessage(3, '2026-03-01T10:00:00Z'),
        ]);

        await list(service, { page: 1, pageSize: 2 });
        const firstPage = client.fetch.mock.calls.at(-1)?.[0];
        await list(service, { page: 2, pageSize: 2 });
        const secondPage = client.fetch.mock.calls.at(-1)?.[0];

        expect([firstPage, secondPage]).toEqual(['3,1', '2']);
      },
    );

    // UID FETCH answers in UID order, which is not date order.
    it.each(listers)('should return the items of a %s page newest first', async (_name, list) => {
      client.search.mockResolvedValue([1, 2]);
      fetchServesRows(client, [
        listedMessage(1, '2026-01-01T10:00:00Z'),
        listedMessage(2, '2026-02-01T10:00:00Z'),
      ]);

      const result = await list(service, {});

      expect(result.items.map((item) => item.id)).toEqual(['2', '1']);
    });
  });

  describe('listEmails ordering', () => {
    it('pages by date newest-first, not by UID', async () => {
      client.search.mockResolvedValue([1, 2]);
      const older = {
        uid: 2,
        envelope: { date: new Date('2020-01-01'), subject: 'old', from: [], to: [] },
        flags: new Set(),
      };
      const newer = {
        uid: 1,
        envelope: { date: new Date('2026-01-01'), subject: 'new', from: [], to: [] },
        flags: new Set(),
      };
      let fetchCalls = 0;
      client.fetch.mockImplementation(() => {
        fetchCalls += 1;
        const rows = fetchCalls === 1 ? [older, newer] : [newer];
        async function* fetchMock() {
          for (const row of rows) yield row;
        }
        return fetchMock();
      });

      const result = await service.listEmails('test', { pageSize: 1 });
      expect(result.items[0].subject).toBe('new');
      expect(result.items[0].id).toBe('1');
    });
  });

  describe('listEmails date criteria', () => {
    it('passes since and before to IMAP as Date values, not strings', async () => {
      client.search.mockResolvedValue([]);
      await service.listEmails('test', {
        since: '2026-01-01',
        before: '2026-02-01',
      });
      expect(client.search).toHaveBeenCalledWith(
        {
          since: new Date('2026-01-01'),
          before: new Date('2026-02-01'),
        },
        { uid: true },
      );
    });
  });

  describe('searchEmails', () => {
    it('passes since and before as IMAP Date values, not strings', async () => {
      client.search.mockResolvedValue([]);
      await service.searchEmails('test', 'invoice', {
        since: '2026-01-01',
        before: '2026-02-01',
      });
      expect(client.search).toHaveBeenCalledWith(
        expect.objectContaining({
          since: new Date('2026-01-01'),
          before: new Date('2026-02-01'),
        }),
        { uid: true },
      );
    });
  });

  describe('listEmails criteria', () => {
    it.each([
      [{}, {}],
      [{ since: '2026-01-01' }, { since: new Date('2026-01-01') }],
      [{ before: '2026-02-01' }, { before: new Date('2026-02-01') }],
      [{ from: 'alice@example.test' }, { from: 'alice@example.test' }],
      [{ subject: 'Invoice' }, { subject: 'Invoice' }],
      [{ seen: true }, { seen: true }],
      [{ seen: false }, { seen: false }],
      [{ flagged: true }, { flagged: true }],
      [{ flagged: false }, { flagged: false }],
      [{ answered: true }, { answered: true }],
      [{ answered: false }, { answered: false }],
      // IMAP has no attachment search; that filter reads the BODYSTRUCTURE afterwards.
      [{ hasAttachment: true }, {}],
    ])('should send the exact criteria for the options %j', async (options, criteria) => {
      await service.listEmails('test', options);

      expect(client.search).toHaveBeenCalledWith(criteria, { uid: true });
    });
  });

  describe('searchEmails criteria', () => {
    const anyField = { or: [{ subject: 'invoice' }, { from: 'invoice' }, { body: 'invoice' }] };

    it.each([
      [{}, anyField],
      [{ to: 'bob@example.test' }, { ...anyField, to: 'bob@example.test' }],
      // largerThan and smallerThan are in KiB; SEARCH LARGER and SMALLER take octets.
      [{ largerThan: 10 }, { ...anyField, larger: 10_240 }],
      [{ smallerThan: 5 }, { ...anyField, smaller: 5120 }],
      [{ answered: true }, { ...anyField, answered: true }],
      [{ answered: false }, { ...anyField, answered: false }],
      [{ since: '2026-01-01' }, { ...anyField, since: new Date('2026-01-01') }],
      [{ before: '2026-02-01' }, { ...anyField, before: new Date('2026-02-01') }],
      [{ hasAttachment: false }, anyField],
    ])(
      'should send the exact criteria for "invoice" with the options %j',
      async (options, criteria) => {
        await service.searchEmails('test', 'invoice', options);

        expect(client.search).toHaveBeenCalledWith(criteria, { uid: true });
      },
    );

    it('should search with no criteria when the query is empty', async () => {
      await service.searchEmails('test', '');

      expect(client.search).toHaveBeenCalledWith({}, { uid: true });
    });
  });

  describe('paging', () => {
    const threeDays = [1, 2, 3].map((uid) => listedMessage(uid, `2026-01-0${uid}T10:00:00Z`));

    beforeEach(() => {
      client.search.mockResolvedValue([1, 2, 3]);
      fetchServesRows(client, threeDays);
    });

    it.each(listers)('should report more pages on page 2 of 3 from %s', async (_name, list) => {
      const result = await list(service, { page: 2, pageSize: 1 });

      expect(result).toEqual({
        items: [expect.objectContaining({ id: '2' })],
        total: 3,
        page: 2,
        pageSize: 1,
        hasMore: true,
      });
    });

    it.each(listers)('should report no more pages on page 3 of 3 from %s', async (_name, list) => {
      const result = await list(service, { page: 3, pageSize: 1 });

      expect(result).toEqual({
        items: [expect.objectContaining({ id: '1' })],
        total: 3,
        page: 3,
        pageSize: 1,
        hasMore: false,
      });
    });

    it.each(listers)(
      'should return an empty page past the last one from %s',
      async (_name, list) => {
        const result = await list(service, { page: 4, pageSize: 1 });

        expect(result).toEqual({ items: [], total: 3, page: 4, pageSize: 1, hasMore: false });
      },
    );

    it.each(listers)(
      'should return an empty first page of 20 when %s matches nothing',
      async (_name, list) => {
        client.search.mockResolvedValue([]);

        const result = await list(service, {});

        expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false });
      },
    );
  });

  describe('attachment filter', () => {
    beforeEach(() => {
      client.search.mockResolvedValue([1, 2]);
      fetchServesRows(client, [
        listedMessage(1, '2026-01-01T10:00:00Z', { bodyStructure: { type: 'text/plain' } }),
        listedMessage(2, '2026-01-02T10:00:00Z', {
          bodyStructure: mixedStructure(attachmentNode('2', 'a.pdf')),
        }),
      ]);
    });

    it.each(listers)(
      'should keep only the messages with an attachment from %s',
      async (_name, list) => {
        const result = await list(service, { hasAttachment: true });

        expect(result.items.map((item) => item.id)).toEqual(['2']);
      },
    );

    it.each(listers)(
      'should keep only the messages without an attachment from %s',
      async (_name, list) => {
        const result = await list(service, { hasAttachment: false });

        expect(result.items.map((item) => item.id)).toEqual(['1']);
      },
    );
  });

  describe('listEmails date-sort window', () => {
    it('caps envelope date-sorting window to newest UIDs when matches exceed 250', async () => {
      const uids = Array.from({ length: 500 }, (_, i) => i + 1);
      client.search.mockResolvedValue(uids);
      let firstFetchRange = '';
      client.fetch.mockImplementation((range: string) => {
        if (!firstFetchRange) firstFetchRange = range;
        async function* fetchMock() {
          yield {
            uid: 500,
            envelope: { date: new Date('2026-03-01'), subject: 'latest', from: [], to: [] },
            flags: new Set(),
          };
        }
        return fetchMock();
      });

      const result = await service.listEmails('test', { page: 1, pageSize: 10 });
      const fetchedUids = firstFetchRange.split(',');
      expect(fetchedUids).toHaveLength(250);
      expect(fetchedUids[0]).toBe('251');
      expect(fetchedUids[249]).toBe('500');
      expect(result.total).toBe(500);
    });
  });

  describe('preview', () => {
    const POLISH = 'Zażółć gęślą jaźń';

    const BASE64_UTF8 = Buffer.from(POLISH).toString('base64');

    /**
     * BODYSTRUCTURE of multipart/alternative mail as imapflow parses it. The plain part is base64,
     * as many clients send non-ASCII text: decoding the whole TEXT section by it yields no text.
     */
    const alternative = {
      type: 'multipart/alternative',
      parameters: { boundary: 'b1' },
      childNodes: [
        {
          part: '1',
          type: 'text/plain',
          parameters: { charset: 'utf-8' },
          encoding: 'base64',
          size: 36,
          lineCount: 1,
        },
        {
          part: '2',
          type: 'text/html',
          parameters: { charset: 'utf-8' },
          encoding: '7bit',
          size: 19,
          lineCount: 1,
        },
      ],
    };
    const alternativeText = [
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      BASE64_UTF8,
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML version</p>',
      '--b1--',
      '',
    ].join('\r\n');
    const plainSinglePart = {
      type: 'text/plain',
      parameters: { charset: 'utf-8' },
      encoding: '7bit',
      size: 4209,
      lineCount: 2101,
    };

    const htmlSinglePart = {
      type: 'text/html',
      parameters: { charset: 'utf-8' },
      encoding: '7bit',
      size: 30,
      lineCount: 1,
    };

    /**
     * UID FETCH BODY.PEEK[section]<start.maxLength> as a server answers it: those octets of each
     * message's section, or NIL, which imapflow hands over as false, for a section it lacks.
     */
    function serveSections(byUid: Record<number, Record<string, string>>) {
      client.fetchAll.mockImplementation(
        async (
          range: string,
          query: { bodyParts: { key: string; start: number; maxLength?: number }[] },
          options?: { uid?: boolean },
        ) => {
          requireUidRange('fetchAll', range, options);
          const [{ key, start, maxLength }] = query.bodyParts;
          const end = maxLength === undefined ? undefined : start + maxLength;
          return range.split(',').map((uid) => {
            const text = byUid[Number(uid)]?.[key];
            const octets = text === undefined ? false : Buffer.from(text).subarray(start, end);
            return { uid: Number(uid), bodyParts: new Map([[key.toLowerCase(), octets]]) };
          });
        },
      );
    }

    /** One page of messages with these BODYSTRUCTUREs, UIDs 1, 2, … in order. */
    function listPage(...bodyStructures: object[]) {
      client.search.mockResolvedValue(bodyStructures.map((_, i) => i + 1));
      fetchServesRows(
        client,
        bodyStructures.map((bodyStructure, i) =>
          listedMessage(i + 1, `2026-10-2${i + 1}T09:12:44Z`, { bodyStructure }),
        ),
      );
    }

    async function previewsById(
      list: Lister = async (svc, options) => svc.listEmails('test', options),
    ) {
      const { items } = await list(service, {});
      return Object.fromEntries(items.map((item) => [item.id, item.preview]));
    }

    it.each(listers)(
      'should preview the plain part of multipart/alternative mail in %s',
      async (_name, list) => {
        listPage(alternative);
        serveSections({ 1: { TEXT: alternativeText, 1: BASE64_UTF8, 2: '<p>HTML version</p>' } });

        expect(await previewsById(list)).toEqual({ 1: POLISH });
      },
    );

    it.each(listers)(
      'should give each message on a %s page its own preview',
      async (_name, list) => {
        // Messages 1 and 3 share the TEXT section, message 2 is fetched by part 1.
        listPage(plainSinglePart, alternative, plainSinglePart);
        serveSections({
          1: { TEXT: 'First message' },
          2: { TEXT: alternativeText, 1: BASE64_UTF8 },
          3: { TEXT: 'Third message' },
        });

        expect(await previewsById(list)).toEqual({
          1: 'First message',
          2: POLISH,
          3: 'Third message',
        });
      },
    );

    it('should preview HTML-only mail as text', async () => {
      listPage(htmlSinglePart);
      serveSections({ 1: { TEXT: '<p>Only <b>HTML</b> here</p>' } });

      expect(await previewsById()).toEqual({ 1: 'Only HTML here' });
    });

    // A blank line is 2 octets: 1500 of them put the text at octet 3000, 2100 at octet 4200.
    it.each([
      [1500, 'Text'],
      [2100, undefined],
    ])(
      'should read only the first 4096 octets of a part (text after %i blank lines → %s)',
      async (blankLines, preview) => {
        listPage(plainSinglePart);
        serveSections({ 1: { TEXT: `${'\r\n'.repeat(blankLines)}Text` } });

        expect(await previewsById()).toEqual({ 1: preview });
      },
    );

    it('should list a message without a preview when the server answers NIL', async () => {
      listPage(alternative);
      serveSections({});

      expect(await previewsById()).toEqual({ 1: undefined });
    });

    it('should list a message without a preview when the preview FETCH fails', async () => {
      listPage(alternative);
      client.fetchAll.mockRejectedValue(new Error('Command failed'));

      expect(await previewsById()).toEqual({ 1: undefined });
    });
  });
});
