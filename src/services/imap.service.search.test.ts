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
});
