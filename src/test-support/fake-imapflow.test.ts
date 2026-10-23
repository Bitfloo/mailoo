import { ImapFlow } from 'imapflow';

import { FakeImapFlow, fake, resetFakeServer, seedFolder, settle } from './fake-imapflow.js';

interface CloseCase {
  when: string;
  port: number;
  secure?: boolean;
  code: string;
}

// Ports chosen against each half of the rule: `secure` wins when set, port 993 only when unset.
const cases: CloseCase[] = [
  { when: 'secure is true on port 143', port: 143, secure: true, code: 'ClosedAfterConnectTLS' },
  { when: 'secure is false on port 993', port: 993, secure: false, code: 'ClosedAfterConnectText' },
  { when: 'secure is unset on port 993', port: 993, code: 'ClosedAfterConnectTLS' },
];

function options({ port, secure }: Pick<CloseCase, 'port' | 'secure'>) {
  return {
    host: 'imap.example.com',
    port,
    ...(secure === undefined ? {} : { secure }),
    auth: { user: 'test@example.com', pass: 'app-password' },
    logger: false as const,
  };
}

beforeEach(resetFakeServer);

describe('FakeImapFlow close during connect', () => {
  it.each(cases)('should reject the pending connect with $code when $when', async (closeCase) => {
    fake.loginPending = new Promise(() => {});
    const client = new FakeImapFlow(options(closeCase));
    const connecting = client.connect();
    client.close();
    await expect(connecting).rejects.toMatchObject({ code: closeCase.code });
  });

  // imap-flow.js 2.5.8 connect(): "The transport goes with the failed attempt", via closeAfter().
  it('should emit close one tick after a refused connect', async () => {
    fake.connectErrors.push(new Error('Invalid credentials'));
    const client = new FakeImapFlow(options({ port: 993 }));
    let closes = 0;
    client.on('close', () => {
      closes += 1;
    });
    await expect(client.connect()).rejects.toThrow('Invalid credentials');
    const closesAtReject = closes;
    await settle();
    expect([closesAtReject, closes]).toEqual([0, 1]);
  });

  // The fake stands in for imapflow, so its socket type must follow the library's own rule.
  it.each(cases)('should count the socket as imapflow does when $when', (closeCase) => {
    const { secureConnection } = new ImapFlow(options(closeCase));
    expect(secureConnection).toBe(closeCase.code.endsWith('TLS'));
  });
});

// The watcher's query tests read what this fetch yields, so it must answer as imapflow 2.5.8 does.
describe('FakeImapFlow fetch', () => {
  async function openInbox(): Promise<FakeImapFlow> {
    const client = new FakeImapFlow(options({ port: 993 }));
    await client.connect();
    await client.mailboxOpen('INBOX');
    return client;
  }

  async function fetchAll(
    client: FakeImapFlow,
    ...args: Parameters<FakeImapFlow['fetch']>
  ): Promise<unknown[]> {
    const messages: unknown[] = [];
    for await (const message of client.fetch(...args)) messages.push(message);
    return messages;
  }

  afterEach(() => {
    fake.clients.forEach((client) => {
      client.close();
    });
  });

  it('should return only the fields the query names', async () => {
    seedFolder('INBOX', [5, 9]);
    const client = await openInbox();
    expect(await fetchAll(client, '1:*', { uid: true })).toStrictEqual([
      { seq: 1, uid: 5 },
      { seq: 2, uid: 9 },
    ]);
  });

  it('should read the range as sequence numbers unless the options say uid', async () => {
    seedFolder('INBOX', [5, 9]);
    const client = await openInbox();
    const bySeq = await fetchAll(client, '2:*', { uid: true });
    const byUid = await fetchAll(client, '2:*', { uid: true }, { uid: true });
    expect({ bySeq, byUid }).toEqual({
      bySeq: [{ seq: 2, uid: 9 }],
      byUid: [
        { seq: 1, uid: 5 },
        { seq: 2, uid: 9 },
      ],
    });
  });

  // imap-flow.js 2.5.8, fetch(): "no mailbox selected, nothing to do".
  it('should yield nothing when no mailbox is selected', async () => {
    seedFolder('INBOX', [5, 9]);
    const client = new FakeImapFlow(options({ port: 993 }));
    await client.connect();
    expect(await fetchAll(client, '1:*', { uid: true })).toEqual([]);
  });

  it('should put the Message-ID in the envelope', async () => {
    seedFolder('INBOX', [5]);
    const client = await openInbox();
    const [message] = await fetchAll(client, '1:*', { uid: true, envelope: true });
    expect(message).toMatchObject({ envelope: { messageId: '<5@example.com>' } });
  });
});
