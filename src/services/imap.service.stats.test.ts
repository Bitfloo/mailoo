import { attachmentNode, mixedStructure } from '../test-support/imap-bodystructure.js';
import {
  createMockConnectionManager,
  createMockImapClient,
  fetchServesRows,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';

const plainBody = { type: 'text/plain' };

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  // The period counts back from now, and a message without a Date header
  // counts on today's date, so the clock is pinned.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-10T12:00:00Z'));
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getEmailStats', () => {
    it.each([
      ['day', '2026-03-09'],
      ['week', '2026-03-03'],
      ['month', '2026-02-10'],
    ] as const)('should report empty stats from the start of the %s', async (period, from) => {
      client.search.mockResolvedValue([]);

      const stats = await service.getEmailStats('test', 'INBOX', period);

      expect(stats).toEqual({
        period,
        dateRange: { from, to: '2026-03-10' },
        totalReceived: 0,
        unreadCount: 0,
        flaggedCount: 0,
        topSenders: [],
        dailyVolume: [],
        hasAttachmentsCount: 0,
        avgPerDay: 0,
      });
    });

    it('should count unread, flagged and attachment mail, senders and days', async () => {
      client.search.mockResolvedValue([11, 12, 13, 14]);
      fetchServesRows(client, [
        {
          uid: 11,
          envelope: {
            date: new Date('2026-03-10T08:00:00Z'),
            from: [{ address: 'bob@example.com' }],
          },
          flags: new Set(['\\Seen']),
          bodyStructure: plainBody,
        },
        {
          uid: 12,
          envelope: {
            date: new Date('2026-03-09T20:00:00Z'),
            from: [{ name: 'Alice Example', address: 'Alice@Example.com' }],
          },
          flags: new Set<string>(),
          bodyStructure: mixedStructure(attachmentNode('2', 'a.pdf')),
        },
        {
          uid: 13,
          envelope: {
            date: new Date('2026-03-08T09:00:00Z'),
            from: [{ name: 'Alice', address: 'alice@example.com' }],
          },
          flags: new Set(['\\Seen', '\\Flagged']),
          bodyStructure: plainBody,
        },
        { uid: 14, envelope: {}, flags: new Set(['\\Seen']), bodyStructure: plainBody },
      ]);

      const stats = await service.getEmailStats('test', 'INBOX', 'week');

      expect(stats).toEqual({
        period: 'week',
        dateRange: { from: '2026-03-03', to: '2026-03-10' },
        totalReceived: 4,
        unreadCount: 1,
        flaggedCount: 1,
        topSenders: [
          { email: 'Alice@Example.com', name: 'Alice Example', count: 2 },
          { email: 'bob@example.com', name: undefined, count: 1 },
        ],
        dailyVolume: [
          { date: '2026-03-08', count: 1 },
          { date: '2026-03-09', count: 1 },
          { date: '2026-03-10', count: 2 },
        ],
        hasAttachmentsCount: 1,
        avgPerDay: 1.3,
      });
    });

    it('should count a message whose Date header imapflow could not parse on today', async () => {
      // imapflow yields the raw header text instead of a Date when the header does not parse.
      client.search.mockResolvedValue([21]);
      fetchServesRows(client, [
        {
          uid: 21,
          envelope: {
            date: 'Thursday, sometime last week',
            from: [{ address: 'bob@example.com' }],
          },
          flags: new Set(['\\Seen']),
          bodyStructure: plainBody,
        },
      ]);

      const stats = await service.getEmailStats('test', 'INBOX', 'week');

      expect(stats.dailyVolume).toEqual([{ date: '2026-03-10', count: 1 }]);
    });

    it('should list the ten most frequent senders', async () => {
      const uids = Array.from({ length: 11 }, (_, i) => i + 1);
      client.search.mockResolvedValue(uids);
      fetchServesRows(
        client,
        uids.map((uid) => ({
          uid,
          envelope: {
            date: new Date('2026-03-09T10:00:00Z'),
            from: [{ address: `sender${uid}@example.com` }],
          },
          flags: new Set(['\\Seen']),
          bodyStructure: plainBody,
        })),
      );

      const stats = await service.getEmailStats('test', 'INBOX', 'week');

      expect(stats.topSenders.map((s) => s.email)).toEqual(
        uids.slice(0, 10).map((uid) => `sender${uid}@example.com`),
      );
    });
  });
});
