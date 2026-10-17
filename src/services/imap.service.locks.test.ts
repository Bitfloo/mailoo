import {
  createMockConnectionManager,
  createMockImapClient,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';
import { MAILBOX_LOCK_TIMEOUT_MS } from './mailbox-lock.js';

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  // A UID names a message only within the selected mailbox: a lock on INBOX
  // would move, flag or expunge the INBOX messages that carry these UIDs.
  describe('locked mailbox', () => {
    it.each<[string, (svc: ImapService) => Promise<unknown>]>([
      ['moveEmail', async (svc) => svc.moveEmail('test', '42', 'Archive', 'Receipts')],
      ['bulkSetFlags', async (svc) => svc.bulkSetFlags('test', [3, 5], 'Archive', 'flag')],
      ['bulkMove', async (svc) => svc.bulkMove('test', [3, 5], 'Archive', 'Receipts')],
      ['bulkDelete permanent', async (svc) => svc.bulkDelete('test', [3, 5], 'Archive', true)],
      ['getThread', async (svc) => svc.getThread('test', '<thread-1@example.test>', 'Archive')],
    ])('should lock the requested mailbox, not INBOX, for %s', async (_name, call) => {
      await call(service);

      expect(client.getMailboxLock.mock.calls).toEqual([
        ['Archive', { acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS }],
      ]);
    });
  });
});
