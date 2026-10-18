import {
  createMockConnectionManager,
  createMockImapClient,
  fetchServesRows,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';

/** Alice under three spellings; UID 3 is older than UID 2. */
const threeMessages = [
  {
    uid: 1,
    envelope: {
      date: new Date('2026-03-01T10:00:00Z'),
      from: [{ name: 'Dave', address: 'dave@example.com' }],
      to: [{ name: 'Alice Old', address: 'Alice@Example.com' }],
    },
  },
  {
    uid: 2,
    envelope: {
      date: new Date('2026-03-05T10:00:00Z'),
      from: [{ name: 'Alice New', address: 'alice@example.com' }],
      to: [{ address: 'me@example.com' }],
      // imapflow's entry for an empty group such as "undisclosed-recipients:;".
      cc: [{ name: 'undisclosed-recipients' }],
    },
  },
  {
    uid: 3,
    envelope: {
      date: new Date('2026-03-03T10:00:00Z'),
      from: [{ name: 'Alice Mid', address: 'ALICE@example.com' }],
      to: [{ address: 'me@example.com' }],
    },
  },
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

  describe('extractContacts', () => {
    it('should merge addresses without case and keep the newest name, most frequent first', async () => {
      client.search.mockResolvedValue([3, 1, 2]);
      fetchServesRows(client, threeMessages);

      const contacts = await service.extractContacts('test');

      expect(contacts).toEqual([
        {
          name: 'Alice New',
          email: 'Alice@Example.com',
          frequency: 3,
          lastSeen: '2026-03-05T10:00:00.000Z',
        },
        {
          name: undefined,
          email: 'me@example.com',
          frequency: 2,
          lastSeen: '2026-03-05T10:00:00.000Z',
        },
        {
          name: 'Dave',
          email: 'dave@example.com',
          frequency: 1,
          lastSeen: '2026-03-01T10:00:00.000Z',
        },
      ]);
    });

    it('should read only the newest messages up to the limit', async () => {
      client.search.mockResolvedValue([3, 1, 2]);
      fetchServesRows(client, threeMessages);

      const contacts = await service.extractContacts('test', { limit: 2 });

      expect(contacts.map((c) => c.email)).toEqual(['alice@example.com', 'me@example.com']);
    });

    it.each([
      ['no limit', undefined, 101],
      ['a limit of 600', 600, 501],
    ])('should leave the oldest message out when given %s', async (_label, limit, count) => {
      client.search.mockResolvedValue(Array.from({ length: count }, (_, i) => i + 1));
      fetchServesRows(client, [
        { uid: 1, envelope: { from: [{ address: 'oldest@example.com' }] } },
        { uid: count, envelope: { from: [{ address: 'newest@example.com' }] } },
      ]);

      const contacts = await service.extractContacts('test', { limit });

      expect(contacts.map((c) => c.email)).toEqual(['newest@example.com']);
    });

    it('should return no contacts for an empty mailbox', async () => {
      client.search.mockResolvedValue([]);

      await expect(service.extractContacts('test')).resolves.toEqual([]);
    });
  });
});
