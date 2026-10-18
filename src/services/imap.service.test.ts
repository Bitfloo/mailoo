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

    it('should skip a text/plain attachment that comes before the body', () => {
      const parts = findTextMimeParts({
        type: 'multipart/mixed',
        childNodes: [
          {
            part: '1',
            type: 'text/plain',
            disposition: 'attachment',
            dispositionParameters: { filename: 'notes.txt' },
          },
          { part: '2', type: 'text/plain' },
        ],
      });
      expect(parts).toEqual({ plain: '2' });
    });

    it('should keep the first text/plain and the first text/html part', () => {
      const parts = findTextMimeParts({
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain' },
          { part: '2', type: 'text/html' },
          { part: '3', type: 'text/plain' },
          { part: '4', type: 'text/html' },
        ],
      });
      expect(parts).toEqual({ plain: '1', html: '2' });
    });

    // RFC 3501: a non-multipart message has only part 1; imapflow gives its root no part number.
    it('should read a message that is one text/plain part as part 1', () => {
      expect(findTextMimeParts({ type: 'text/plain' })).toEqual({ plain: '1' });
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
});
