import {
  createMockConnectionManager,
  createMockImapClient,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
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
