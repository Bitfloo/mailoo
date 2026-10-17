import {
  createMockConnectionManager,
  createMockImapClient,
} from '../test-support/imap-client-fake.js';
import ImapService, { findTextMimeParts } from './imap.service.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  // -----------------------------------------------------------------------
  // Label strategy detection
  // -----------------------------------------------------------------------

  describe('label strategy detection', () => {
    // A cached rejection would fail every label tool on the account until restart.
    it('should detect the strategy again when the previous detection failed', async () => {
      client.list.mockRejectedValueOnce(new Error('LIST failed'));
      await expect(service.listLabels('test')).rejects.toThrow('LIST failed');

      await expect(service.listLabels('test')).resolves.toEqual([]);
    });

    // Detection sends LIST and may SELECT INBOX, which would otherwise repeat on every label call.
    it.each<[string, (svc: ImapService) => Promise<unknown>]>([
      [
        'one after the other',
        async (svc) => {
          await svc.listLabels('test');
          await svc.listLabels('test');
        },
      ],
      [
        'at the same time',
        async (svc) => Promise.all([svc.listLabels('test'), svc.listLabels('test')]),
      ],
    ])('should detect the strategy once for two calls made %s', async (_when, calls) => {
      await calls(service);

      expect(client.list).toHaveBeenCalledTimes(1);
    });
  });

  describe('findTextMimeParts', () => {
    it('selects leaf 1.1/1.2 instead of container part 1', () => {
      const parts = findTextMimeParts({
        type: 'multipart/related',
        part: '1',
        childNodes: [
          {
            type: 'multipart/alternative',
            part: '1',
            childNodes: [
              { type: 'text/plain', part: '1.1' },
              { type: 'text/html', part: '1.2' },
            ],
          },
        ],
      });
      expect(parts).toEqual({ plain: '1.1', html: '1.2' });
    });

    it('skips attachment and message/rfc822 subtrees', () => {
      const parts = findTextMimeParts({
        type: 'multipart/mixed',
        childNodes: [
          { type: 'text/plain', part: '1' },
          { type: 'text/plain', part: '2', disposition: 'attachment' },
          { type: 'message/rfc822', part: '3', childNodes: [{ type: 'text/html', part: '3.1' }] },
        ],
      });
      expect(parts.plain).toBe('1');
      expect(parts.html).toBeUndefined();
    });
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
