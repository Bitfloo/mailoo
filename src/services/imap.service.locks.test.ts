import os from 'node:os';
import path from 'node:path';

import { attachmentNode, mixedStructure } from '../test-support/imap-bodystructure.js';
import {
  createMockConnectionManager,
  createMockImapClient,
  downloadReturnsPartName,
  fetchOneByUid,
} from '../test-support/imap-client-fake.js';
import lockCallsByOwner from '../test-support/lock-sites.js';
import ImapService from './imap.service.js';
import { MAILBOX_LOCK_TIMEOUT_MS } from './mailbox-lock.js';

type Client = ReturnType<typeof createMockImapClient>;
type Command = Exclude<keyof Client, 'usable' | 'namespace' | '_releaseFn'>;

/** One lockMailbox call site in imap.service.ts, reached with mailbox 'Archive'. */
interface LockSite {
  /** The ImapService method that makes the call. */
  method: string;
  call: (svc: ImapService) => Promise<unknown>;
  /** Programs the commands after the lock so the call succeeds; the default fake already does. */
  serve?: (client: Client) => void;
  /** The command after the lock that the failure case makes reject. */
  fails: Command;
  /** Locks the call takes: 2 where a second site follows the first. */
  locks?: number;
  readOnly?: boolean;
}

const message = { uid: 9, envelope: {}, flags: new Set<string>() };
const plainBody = { type: 'text/plain', part: '1' };
const headers = Buffer.from('Message-ID: <locks@example.test>\r\n\r\n');
const unusedDir = path.join(os.tmpdir(), 'mailoo-lock-sites-unused');

/** fetchOne as exportEmail sends it: RFC822.SIZE first, then the source. */
async function sizeThenSource(_uid: string, query: { source?: unknown }) {
  return query.source ? { uid: 9, source: Buffer.from('raw') } : { uid: 9, size: 3 };
}

const SITES: Record<string, LockSite> = {
  listEmails: {
    method: 'listEmails',
    call: async (svc) => svc.listEmails('test', { mailbox: 'Archive' }),
    fails: 'search',
  },
  getEmail: {
    method: 'getEmail',
    call: async (svc) => svc.getEmail('test', '9', 'Archive'),
    serve: (c) =>
      c.fetchOne.mockResolvedValue({
        ...message,
        bodyStructure: plainBody,
        source: Buffer.from('Subject: x\r\n\r\nbody'),
      }),
    fails: 'fetchOne',
  },
  getEmails: {
    method: 'getEmails',
    call: async (svc) => svc.getEmails('test', ['9'], 'Archive'),
    serve: (c) => c.fetchAll.mockResolvedValue([{ ...message, bodyStructure: plainBody }]),
    fails: 'fetchAll',
  },
  getEmailFlags: {
    method: 'getEmailFlags',
    call: async (svc) => svc.getEmailFlags('test', '9', 'Archive'),
    serve: (c) => c.fetchOne.mockResolvedValue(message),
    fails: 'fetchOne',
  },
  searchEmails: {
    method: 'searchEmails',
    call: async (svc) => svc.searchEmails('test', 'invoice', { mailbox: 'Archive' }),
    fails: 'search',
  },
  'findEmailFolder source': {
    method: 'findEmailFolder',
    call: async (svc) => svc.findEmailFolder('test', '9', 'Archive'),
    serve: (c) => c.fetchOne.mockResolvedValue({ uid: 9, headers }),
    fails: 'fetchOne',
  },
  'findEmailFolder search': {
    method: 'findEmailFolder',
    call: async (svc) => svc.findEmailFolder('test', '9', 'Archive'),
    serve: (c) => {
      c.fetchOne.mockResolvedValue({ uid: 9, headers });
      c.list.mockResolvedValue([{ path: 'Archive', listed: true, flags: new Set<string>() }]);
      c.search.mockResolvedValue([9]);
    },
    fails: 'search',
    locks: 2,
  },
  moveEmail: {
    method: 'moveEmail',
    call: async (svc) => svc.moveEmail('test', '42', 'Archive', 'Receipts'),
    fails: 'messageMove',
  },
  'deleteEmail permanent': {
    method: 'deleteEmail',
    call: async (svc) => svc.deleteEmail('test', '9', 'Archive', true),
    fails: 'messageDelete',
  },
  'deleteEmail to Trash': {
    method: 'deleteEmail',
    call: async (svc) => svc.deleteEmail('test', '9', 'Archive', false),
    fails: 'messageMove',
  },
  setFlags: {
    method: 'setFlags',
    call: async (svc) => svc.setFlags('test', '9', 'Archive', 'flag'),
    fails: 'messageFlagsAdd',
  },
  bulkSetFlags: {
    method: 'bulkSetFlags',
    call: async (svc) => svc.bulkSetFlags('test', [3, 5], 'Archive', 'flag'),
    fails: 'messageFlagsAdd',
  },
  bulkMove: {
    method: 'bulkMove',
    call: async (svc) => svc.bulkMove('test', [3, 5], 'Archive', 'Receipts'),
    fails: 'messageMove',
  },
  'bulkDelete permanent': {
    method: 'bulkDelete',
    call: async (svc) => svc.bulkDelete('test', [3, 5], 'Archive', true),
    fails: 'messageDelete',
  },
  'bulkDelete to Trash': {
    method: 'bulkDelete',
    call: async (svc) => svc.bulkDelete('test', [3, 5], 'Archive'),
    fails: 'messageMove',
  },
  getEmailSecurity: {
    method: 'getEmailSecurity',
    call: async (svc) => svc.getEmailSecurity('test', '9', 'Archive'),
    serve: (c) => c.fetchOne.mockResolvedValue({ ...message, headers }),
    fails: 'fetchOne',
    readOnly: true,
  },
  peekText: {
    method: 'peekText',
    call: async (svc) => svc.peekText('test', '9', 'Archive'),
    serve: (c) => c.fetchOne.mockResolvedValue({ uid: 9, bodyStructure: plainBody }),
    fails: 'fetchOne',
    readOnly: true,
  },
  peekAttachments: {
    method: 'peekAttachments',
    call: async (svc) => svc.peekAttachments('test', '9', 'Archive'),
    serve: (c) => c.fetchOne.mockResolvedValue({ uid: 9, bodyStructure: plainBody }),
    fails: 'fetchOne',
    readOnly: true,
  },
  deleteDraft: {
    method: 'deleteDraft',
    call: async (svc) => svc.deleteDraft('test', 9, 'Archive'),
    fails: 'messageDelete',
  },
  downloadAttachment: {
    method: 'downloadAttachment',
    call: async (svc) => svc.downloadAttachment('test', '9', 'Archive', 'a.txt'),
    serve: (c) => {
      fetchOneByUid(c, { uid: 9, bodyStructure: mixedStructure(attachmentNode('2', 'a.txt')) });
      downloadReturnsPartName(c);
    },
    fails: 'download',
  },
  exportEmail: {
    method: 'exportEmail',
    call: async (svc) => svc.exportEmail('test', '9', 'Archive', 1024),
    serve: (c) => c.fetchOne.mockImplementation(sizeThenSource),
    fails: 'fetchOne',
    readOnly: true,
  },
  // A message with no attachment saves nothing, so no file is written.
  saveEmailAttachments: {
    method: 'saveEmailAttachments',
    call: async (svc) => svc.saveEmailAttachments('test', '9', 'Archive', unusedDir),
    serve: (c) => c.fetchOne.mockResolvedValue({ uid: 9, bodyStructure: plainBody }),
    fails: 'fetchOne',
  },
  getThread: {
    method: 'getThread',
    call: async (svc) => svc.getThread('test', '<thread-1@example.test>', 'Archive'),
    serve: (c) => c.search.mockResolvedValue([9]),
    fails: 'fetchAll',
  },
  extractContacts: {
    method: 'extractContacts',
    call: async (svc) => svc.extractContacts('test', { mailbox: 'Archive' }),
    fails: 'search',
  },
  getEmailStats: {
    method: 'getEmailStats',
    call: async (svc) => svc.getEmailStats('test', 'Archive', 'week'),
    fails: 'search',
  },
  getCalendarParts: {
    method: 'getCalendarParts',
    call: async (svc) => svc.getCalendarParts('test', 'Archive', '9'),
    serve: (c) => c.fetchOne.mockResolvedValue({ uid: 9, bodyStructure: plainBody }),
    fails: 'fetchOne',
  },
};

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  it('should have one lock site row per lockMailbox call in imap.service.ts', async () => {
    const rows: Record<string, number> = {};
    Object.values(SITES).forEach(({ method }) => {
      rows[method] = (rows[method] ?? 0) + 1;
    });

    expect(rows).toEqual(await lockCallsByOwner('imap.service.ts'));
  });

  // A UID names a message only within the selected mailbox: a lock on INBOX
  // would read, move, flag or expunge the INBOX messages that carry these UIDs.
  describe('locked mailbox', () => {
    it.each(Object.entries(SITES))(
      'should lock the requested mailbox, not INBOX, for %s',
      async (_site, site) => {
        site.serve?.(client);

        await site.call(service);

        const options = site.readOnly
          ? { readOnly: true, acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS }
          : { acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS };
        expect(client.getMailboxLock.mock.calls).toEqual(
          Array.from({ length: site.locks ?? 1 }, () => ['Archive', options]),
        );
      },
    );
  });

  // A lock left held makes every later call on the account wait out the lock timeout.
  describe('lock release', () => {
    it.each(Object.entries(SITES))(
      'should release each lock once when %s succeeds',
      async (_site, site) => {
        site.serve?.(client);

        await site.call(service);

        expect(client._releaseFn).toHaveBeenCalledTimes(site.locks ?? 1);
      },
    );

    it.each(Object.entries(SITES))(
      'should release each lock once when the server fails a command in %s',
      async (_site, site) => {
        site.serve?.(client);
        client[site.fails].mockRejectedValue(new Error('Command failed: NO [UNAVAILABLE]'));

        await site.call(service).catch(() => undefined);

        // Without the failing command having run, this would only repeat the success case.
        expect({
          failed: client[site.fails].mock.calls.length > 0,
          releases: client._releaseFn.mock.calls.length,
        }).toEqual({ failed: true, releases: site.locks ?? 1 });
      },
    );
  });
});
