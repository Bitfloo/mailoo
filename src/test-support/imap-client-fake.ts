/** imapflow client and connection-manager fakes for the ImapService unit suites. */

import { Readable } from 'node:stream';

import type { Mock } from 'vitest';

import type { IConnectionManager } from '../connections/types.js';

type ImapCommand =
  | 'getMailboxLock'
  | 'list'
  | 'status'
  | 'fetch'
  | 'fetchAll'
  | 'search'
  | 'messageMove'
  | 'messageDelete'
  | 'messageFlagsAdd'
  | 'messageFlagsRemove'
  | 'append'
  | 'download'
  | 'fetchOne'
  | 'mailboxCreate'
  | 'mailboxRename'
  | 'mailboxDelete'
  | 'getQuota';

// Written out because tsc cannot name the inferred vi.fn() type in a declaration.
export type MockImapClient = Record<ImapCommand, Mock> & {
  usable: boolean;
  namespace: { prefix: string; delimiter: string } | undefined;
  _releaseFn: Mock;
};

export type MockConnectionManager = Record<keyof IConnectionManager, Mock>;

export function createMockImapClient(): MockImapClient {
  const releaseFn = vi.fn();
  return {
    usable: true,
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: 5, unseen: 2 }),
    fetch: vi.fn().mockReturnValue((async function* fetchMock() {})()),
    fetchAll: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue([]),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    append: vi.fn().mockResolvedValue({ uid: 7 }),
    download: vi.fn(),
    fetchOne: vi.fn(),
    mailboxCreate: vi.fn().mockResolvedValue({ path: 'created', created: true }),
    mailboxRename: vi.fn().mockResolvedValue({ path: 'old', newPath: 'new' }),
    mailboxDelete: vi.fn().mockResolvedValue({ path: 'deleted' }),
    // imapflow resolves false when the server has no QUOTA extension.
    getQuota: vi.fn().mockResolvedValue(false),
    namespace: undefined,
    _releaseFn: releaseFn,
  };
}

/** LIST of a Gmail account as imapflow returns it (SPECIAL-USE advertised). */
export function gmailMailboxes() {
  return [
    { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
    { name: '[Gmail]', path: '[Gmail]', flags: new Set(['\\Noselect']) },
    { name: 'All Mail', path: '[Gmail]/All Mail', specialUse: '\\All', flags: new Set(['\\All']) },
    {
      name: 'Drafts',
      path: '[Gmail]/Drafts',
      specialUse: '\\Drafts',
      flags: new Set(['\\Drafts']),
    },
    // imapflow derives specialUse only for the roles it knows; \Important is not one.
    { name: 'Important', path: '[Gmail]/Important', flags: new Set(['\\Important']) },
    {
      name: 'Sent Mail',
      path: '[Gmail]/Sent Mail',
      specialUse: '\\Sent',
      flags: new Set(['\\Sent']),
    },
    { name: 'Spam', path: '[Gmail]/Spam', specialUse: '\\Junk', flags: new Set(['\\Junk']) },
    {
      name: 'Starred',
      path: '[Gmail]/Starred',
      specialUse: '\\Flagged',
      flags: new Set(['\\Flagged']),
    },
    { name: 'Trash', path: '[Gmail]/Trash', specialUse: '\\Trash', flags: new Set(['\\Trash']) },
    { name: 'Receipts', path: 'Receipts', flags: new Set<string>() },
  ];
}

/**
 * imapflow sends a range without { uid: true } as sequence numbers, and those
 * name another message once an earlier one is expunged.
 */
export function requireUidRange(command: string, range: string, options?: { uid?: boolean }) {
  if (options?.uid !== true) {
    throw new Error(`${command}(${range}) sent a sequence number, not a UID`);
  }
}

/**
 * imapflow runs one command at a time per connection, and a FETCH holds the
 * connection until its iterator finishes. A command issued inside the loop
 * never starts; against a server the call hangs until the socket times out.
 * Here such a command rejects at once and is recorded, so the unit lane fails
 * without GreenMail. Configure the client's other mocks before calling this.
 */
export function rejectCommandsDuringFetch(client: MockImapClient, rows: Record<string, unknown>[]) {
  const issuedDuringFetch: string[] = [];
  let fetchOpen = false;
  const commands = client as unknown as Record<string, (...args: unknown[]) => unknown>;
  const guard =
    (name: string, command: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      if (fetchOpen) {
        issuedDuringFetch.push(name);
        throw new Error(`${name} issued while a FETCH iterator is open`);
      }
      return command(...args);
    };
  [
    'download',
    'fetchOne',
    'search',
    'list',
    'status',
    'messageMove',
    'messageDelete',
    'messageFlagsAdd',
    'messageFlagsRemove',
    'append',
  ].forEach((name) => {
    commands[name] = guard(name, commands[name]);
  });
  // Only the rows in the requested UID set, as UID FETCH returns them.
  client.fetch.mockImplementation((range: unknown) => {
    const uids = new Set(String(range).split(',').map(Number));
    async function* openFetch() {
      fetchOpen = true;
      try {
        yield* rows.filter((row) => uids.has(row.uid as number));
      } finally {
        fetchOpen = false;
      }
    }
    return openFetch();
  });
  // imapflow's fetchAll drains fetch and returns the rows after the FETCH completes.
  commands.fetchAll = guard('fetchAll', async (...args: unknown[]) => {
    requireUidRange('fetchAll', String(args[0]), args[2] as { uid?: boolean } | undefined);
    const collected: unknown[] = [];
    for await (const row of client.fetch(...args)) collected.push(row);
    return collected;
  });
  return issuedDuringFetch;
}

export function createMockConnectionManager(mockClient: MockImapClient): MockConnectionManager {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    resolveAccountName: vi.fn().mockReturnValue('test'),
    getImapClient: vi.fn().mockResolvedValue(mockClient),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

/** client.fetch as a UID FETCH answers: only the rows in the requested UID set, in UID order. */
export function fetchServesRows(
  client: MockImapClient,
  rows: ({ uid: number } & Record<string, unknown>)[],
) {
  client.fetch.mockImplementation((range: string, _query: unknown, options?: { uid?: boolean }) => {
    requireUidRange('fetch', range, options);
    const uids = new Set(range.split(',').map(Number));
    async function* uidFetch() {
      yield* rows.filter((row) => uids.has(row.uid)).sort((a, b) => a.uid - b.uid);
    }
    return uidFetch();
  });
}

/** client.fetchOne as imapflow answers a UID FETCH: false for a UID the mailbox does not hold. */
export function fetchOneByUid(
  client: MockImapClient,
  message: { uid: number } & Record<string, unknown>,
) {
  client.fetchOne.mockImplementation(
    async (range: string, _query: unknown, options?: { uid?: boolean }) => {
      requireUidRange('fetchOne', range, options);
      return range === String(message.uid) ? message : false;
    },
  );
}

/** client.download as imapflow resolves it: decoded part content as a stream. */
export function downloadReturnsPartName(client: MockImapClient) {
  client.download.mockImplementation(
    async (uid: string, part: string, options?: { uid?: boolean }) => {
      requireUidRange('download', uid, options);
      return {
        meta: { contentType: 'text/plain' },
        content: Readable.from([Buffer.from(`body-of-part-${part}`)]),
      };
    },
  );
}
