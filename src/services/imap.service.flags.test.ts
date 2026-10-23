import {
  createMockConnectionManager,
  createMockImapClient,
  fetchOneByUid,
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

  describe('bulkSetFlags', () => {
    it.each([
      ['mark_read', 'messageFlagsAdd', '\\Seen'],
      ['mark_unread', 'messageFlagsRemove', '\\Seen'],
      ['flag', 'messageFlagsAdd', '\\Flagged'],
      ['unflag', 'messageFlagsRemove', '\\Flagged'],
    ] as const)('should apply %s with %s(%s) to every id', async (action, method, flag) => {
      const result = await service.bulkSetFlags('test', [3, 5], 'INBOX', action);

      expect(result).toEqual({ total: 2, succeeded: 2, failed: 0 });
      expect(client[method]).toHaveBeenCalledWith('3,5', [flag], { uid: true });
    });

    it('should report every id failed when the server refuses the flag change', async () => {
      client.messageFlagsAdd.mockResolvedValue(false);

      const result = await service.bulkSetFlags('test', [3, 5], 'INBOX', 'mark_read');

      expect(result).toEqual({
        total: 2,
        succeeded: 0,
        failed: 2,
        errors: ['IMAP server rejected the flag operation.'],
      });
    });

    it('should report the server error when the flag change fails', async () => {
      client.messageFlagsAdd.mockRejectedValue(new Error('Command failed: NO [UNAVAILABLE]'));

      const result = await service.bulkSetFlags('test', [3, 5], 'INBOX', 'mark_read');

      expect(result).toEqual({
        total: 2,
        succeeded: 0,
        failed: 2,
        errors: ['Command failed: NO [UNAVAILABLE]'],
      });
    });
  });

  describe('setFlags', () => {
    it('adds Seen flag for read action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'read');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsRemove).not.toHaveBeenCalled();
    });

    it('removes Seen flag for unread action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'unread');

      expect(client.messageFlagsRemove).toHaveBeenCalledWith('10', ['\\Seen'], { uid: true });
      expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it('adds Flagged flag for flag action', async () => {
      await service.setFlags('test', '10', 'INBOX', 'flag');

      expect(client.messageFlagsAdd).toHaveBeenCalledWith('10', ['\\Flagged'], { uid: true });
    });

    // imapflow resolves a refused STORE to false instead of rejecting.
    it.each([
      ['read', 'messageFlagsAdd'],
      ['unflag', 'messageFlagsRemove'],
    ] as const)('should reject when the server refuses the %s change', async (action, command) => {
      client[command].mockResolvedValue(false);

      await expect(service.setFlags('test', '10', 'INBOX', action)).rejects.toThrow(
        `IMAP server rejected the ${action} flag operation.`,
      );
    });
  });

  describe('getEmailFlags', () => {
    it('should report the flags, keywords, subject, sender and date of the message', async () => {
      fetchOneByUid(client, {
        uid: 9,
        envelope: {
          subject: 'Invoice',
          from: [{ name: 'Alice Example', address: 'alice@example.com' }],
          date: new Date('2026-03-01T10:00:00Z'),
        },
        flags: new Set(['\\Seen', '\\Answered', '$Work']),
      });

      const flags = await service.getEmailFlags('test', '9', 'INBOX');

      expect(flags).toEqual({
        seen: true,
        flagged: false,
        answered: true,
        labels: ['$Work'],
        subject: 'Invoice',
        from: 'Alice Example <alice@example.com>',
        date: '2026-03-01T10:00:00.000Z',
      });
    });

    it('should fall back for a message with no subject, no sender name and no date', async () => {
      fetchOneByUid(client, {
        uid: 9,
        envelope: { from: [{ address: 'bob@example.com' }] },
        flags: new Set(['\\Flagged']),
      });

      const flags = await service.getEmailFlags('test', '9', 'INBOX');

      expect(flags).toEqual({
        seen: false,
        flagged: true,
        answered: false,
        labels: [],
        subject: '(no subject)',
        from: 'bob@example.com',
        date: '',
      });
    });

    it('should date a message whose Date header imapflow could not parse when it was seen', async () => {
      // imapflow yields the raw header text instead of a Date when the header does not parse.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
      try {
        fetchOneByUid(client, {
          uid: 9,
          envelope: { date: 'Thursday, sometime last week' },
          flags: new Set<string>(),
        });

        const flags = await service.getEmailFlags('test', '9', 'INBOX');

        expect(flags.date).toBe('2028-01-15T00:00:00.000Z');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should report a UID the mailbox does not hold as not found', async () => {
      fetchOneByUid(client, { uid: 9, envelope: {}, flags: new Set<string>() });

      await expect(service.getEmailFlags('test', '8', 'Archive')).rejects.toThrow(
        'Email 8 not found in Archive',
      );
    });
  });
});
