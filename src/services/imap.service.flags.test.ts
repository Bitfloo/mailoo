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
  });
});
