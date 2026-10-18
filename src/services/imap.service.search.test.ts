import { attachmentNode, mixedStructure } from '../test-support/imap-bodystructure.js';
import {
  createMockConnectionManager,
  createMockImapClient,
  fetchServesRows,
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
});
