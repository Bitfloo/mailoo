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

    // A UID names a message only in the mailbox it came from.
    it.each([
      ['addLabel', 'messageFlagsAdd'],
      ['removeLabel', 'messageFlagsRemove'],
    ] as const)(
      'should run %s in the given mailbox with the trimmed label',
      async (method, command) => {
        await service.listLabels('test'); // detects the keyword strategy, which reads INBOX
        client.getMailboxLock.mockClear();

        await service[method]('test', '5', 'Archive', '  Work  ');

        expect([
          client.getMailboxLock.mock.calls.map((call) => call[0]),
          client[command].mock.calls,
        ]).toEqual([['Archive'], [['5', ['Work'], { uid: true }]]]);
      },
    );
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

  describe('getCapabilities', () => {
    // imapflow maps each capability name to true, or to a number such as APPENDLIMIT's.
    it('should return the capability names the server announced', async () => {
      Object.assign(client, {
        capabilities: new Map<string, boolean | number>([
          ['IMAP4rev1', true],
          ['IDLE', true],
          ['APPENDLIMIT', 35651584],
        ]),
      });

      await expect(service.getCapabilities('test')).resolves.toEqual([
        'IMAP4rev1',
        'IDLE',
        'APPENDLIMIT',
      ]);
    });

    it('should return no names before the server has announced any', async () => {
      Object.assign(client, { capabilities: new Map() });

      await expect(service.getCapabilities('test')).resolves.toEqual([]);
    });
  });

  describe('getQuota', () => {
    it('should report the INBOX storage quota in MB', async () => {
      // imapflow's QUOTA answer: storage KB from the wire multiplied into bytes.
      client.getQuota.mockResolvedValue({
        path: 'INBOX',
        storage: { usage: 2 * 1024 * 1024, limit: 4 * 1024 * 1024, status: '50%' },
      });

      const quota = await service.getQuota('test');

      expect([quota, client.getQuota.mock.calls]).toEqual([
        { usedMb: 2, totalMb: 4, percentage: 50 },
        [['INBOX']],
      ]);
    });

    it.each([
      ['the server has no QUOTA extension', false],
      ['the quota root has no storage limit', { path: 'INBOX' }],
      ['the storage limit is 0', { path: 'INBOX', storage: { usage: 0, limit: 0, status: '0%' } }],
    ])('should report no quota when %s', async (_, answer) => {
      client.getQuota.mockResolvedValue(answer);

      await expect(service.getQuota('test')).resolves.toBeNull();
    });

    it('should report no quota when the QUOTA command fails', async () => {
      client.getQuota.mockRejectedValue(new Error('Command failed: NO [UNAVAILABLE]'));

      await expect(service.getQuota('test')).resolves.toBeNull();
    });
  });
});
