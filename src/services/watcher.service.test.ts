import type { EventEmitter } from 'node:events';

import type { AccessTokenSource } from '../connections/types.js';
import type { AccountConfig, WatcherConfig } from '../types/index.js';
import type { NewEmailEvent } from './event-bus.js';
import { EmailEventBus } from './event-bus.js';
import WatcherService, { buildEmailMeta } from './watcher.service.js';

interface FakeMessage {
  uid: number;
  subject: string;
}

interface FakeFolder {
  uidValidity: bigint;
  uidNext: number;
  messages: FakeMessage[];
}

interface FakeClient extends EventEmitter {
  readonly options: Record<string, unknown> & { auth: Record<string, unknown> };
  usable: boolean;
  closed: boolean;
  loggedOut: boolean;
  notify: (path: string) => void;
  noteExpunge: (path: string, removed: number) => void;
  close: () => void;
}

// In-memory IMAP server shared by every fake connection.
const fake = vi.hoisted(() => ({
  folders: new Map<string, FakeFolder>(),
  clients: [] as FakeClient[],
  // Errors the next connect() calls reject with, in order; empty means success.
  connectErrors: [] as Error[],
  // While set, connect() waits for it: a login the server has not answered yet.
  loginPending: null as Promise<void> | null,
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('imapflow', async () => {
  const { EventEmitter: EE } = await import('node:events');
  // imapflow's default wait before it starts IDLE on a free connection.
  const AUTO_IDLE_DEFAULT_MS = 15_000;

  interface FakeMailbox {
    path: string;
    uidValidity: bigint;
    uidNext: number;
    exists: number;
  }

  /**
   * Follows imapflow where the watcher depends on it: IDLE starts only once the connection has
   * been free (no lock held, no command running) for `autoIdleDelay`, the server pushes EXISTS
   * only while idling or in a command response, and fetch reads its range as UIDs only when the
   * third argument says `{ uid: true }`.
   */
  class FakeImapFlow extends EE {
    usable = false;

    closed = false;

    loggedOut = false;

    mailbox: false | FakeMailbox = false;

    private locksHeld = 0;

    private idling = false;

    private knownCount = 0;

    // imapflow grants mailbox locks one at a time, in request order.
    private lockQueue: Promise<void> = Promise.resolve();

    private idleTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(readonly options: Record<string, unknown> & { auth: Record<string, unknown> }) {
      super();
      fake.clients.push(this);
    }

    async connect(): Promise<void> {
      await (fake.loginPending ?? Promise.resolve());
      // imapflow rejects a pending connect() when close() is called.
      if (this.closed) throw new Error('Unexpected close');
      const error = fake.connectErrors.shift();
      // Like imapflow, a rejected login leaves the socket open.
      if (error) throw error;
      this.usable = true;
    }

    async mailboxOpen(path: string): Promise<FakeMailbox> {
      await this.command();
      return this.select(path);
    }

    async getMailboxLock(path: string): Promise<{ path: string; release: () => void }> {
      const previous = this.lockQueue;
      let grantNext = (): void => {};
      this.lockQueue = new Promise((resolve) => {
        grantNext = resolve;
      });
      await previous;
      try {
        await this.command();
        if (!this.mailbox || this.mailbox.path !== path) this.select(path);
      } catch (err) {
        grantNext();
        throw err;
      }
      this.locksHeld += 1;
      clearTimeout(this.idleTimer);
      let released = false;
      return {
        path,
        release: () => {
          if (released) return;
          released = true;
          this.locksHeld -= 1;
          grantNext();
          this.armIdle();
        },
      };
    }

    async* fetch(
      range: string,
      _query: Record<string, unknown>,
      options?: { uid?: boolean },
    ): AsyncGenerator<{
      seq: number;
      uid: number;
      flags: Set<string>;
      envelope: { subject: string; from: { address: string }[]; date: Date };
    }> {
      await this.command();
      const folder = this.mailbox ? fake.folders.get(this.mailbox.path) : undefined;
      if (!folder) throw new Error('No mailbox selected');
      const field = options?.uid === true ? 'uid' : 'seq';
      const numbered = folder.messages.map((message, index) => ({ ...message, seq: index + 1 }));
      const highest = numbered.at(-1)?.[field] ?? 0;
      // IMAP reads `N:*` as the span between N and the highest number, so it still matches the
      // newest message when N is past it.
      const low = Math.min(Number(range.split(':')[0]), highest);

      for (const message of numbered) {
        if (highest > 0 && message[field] >= low) {
          yield {
            seq: message.seq,
            uid: message.uid,
            flags: new Set<string>(),
            envelope: {
              subject: message.subject,
              from: [{ address: 'sender@example.com' }],
              date: new Date('2026-10-01T08:00:00.000Z'),
            },
          };
        }
      }
      this.armIdle();
    }

    async logout(): Promise<void> {
      await Promise.resolve();
      this.loggedOut = true;
      this.shutdown();
    }

    close(): void {
      this.shutdown();
    }

    notify(path: string): void {
      if (this.closed || !this.mailbox || this.mailbox.path !== path) return;
      if (this.idling) this.reportExists();
    }

    noteExpunge(path: string, removed: number): void {
      if (this.mailbox && this.mailbox.path === path) this.knownCount -= removed;
    }

    private async command(): Promise<void> {
      if (this.closed) throw new Error('Connection not available');
      this.idling = false;
      clearTimeout(this.idleTimer);
      await Promise.resolve();
      // The command response carries the EXISTS updates the server held back.
      this.reportExists();
    }

    private select(path: string): FakeMailbox {
      const folder = fake.folders.get(path);
      if (!folder) {
        throw Object.assign(new Error('Command failed'), { serverResponseCode: 'NONEXISTENT' });
      }
      this.knownCount = folder.messages.length;
      this.mailbox = {
        path,
        uidValidity: folder.uidValidity,
        uidNext: folder.uidNext,
        exists: folder.messages.length,
      };
      this.armIdle();
      return this.mailbox;
    }

    private armIdle(): void {
      clearTimeout(this.idleTimer);
      if (this.closed || !this.mailbox || this.locksHeld > 0) return;
      const delay =
        typeof this.options.autoIdleDelay === 'number'
          ? this.options.autoIdleDelay
          : AUTO_IDLE_DEFAULT_MS;
      this.idleTimer = setTimeout(() => {
        this.idling = true;
        this.reportExists();
      }, delay);
    }

    private reportExists(): void {
      if (!this.mailbox) return;
      const count = fake.folders.get(this.mailbox.path)?.messages.length ?? 0;
      if (count <= this.knownCount) return;
      const prevCount = this.knownCount;
      this.knownCount = count;
      this.emit('exists', { path: this.mailbox.path, count, prevCount });
    }

    private shutdown(): void {
      if (this.closed) return;
      this.closed = true;
      this.usable = false;
      this.idling = false;
      clearTimeout(this.idleTimer);
      this.emit('close');
    }
  }

  return { ImapFlow: FakeImapFlow };
});

/** UIDs with gaps, as left behind by earlier expunges, so UIDs and sequence numbers differ. */
function seedFolder(path: string, uids: number[], uidValidity = 7n): void {
  fake.folders.set(path, {
    uidValidity,
    uidNext: Math.max(0, ...uids) + 1,
    messages: uids.map((uid) => ({ uid, subject: `Message ${uid}` })),
  });
}

function folderAt(path: string): FakeFolder {
  const folder = fake.folders.get(path);
  if (!folder) throw new Error(`no folder ${path}`);
  return folder;
}

/** Delivers the messages together, as one server-side change. */
function deliver(path: string, ...subjects: string[]): number[] {
  const folder = folderAt(path);
  const uids = subjects.map((subject) => {
    const uid = folder.uidNext;
    folder.uidNext += 1;
    folder.messages.push({ uid, subject });
    return uid;
  });
  fake.clients.forEach((client) => {
    client.notify(path);
  });
  return uids;
}

function expunge(path: string, uids: number[]): void {
  const folder = folderAt(path);
  const before = folder.messages.length;
  folder.messages = folder.messages.filter((message) => !uids.includes(message.uid));
  fake.clients.forEach((client) => {
    client.noteExpunge(path, before - folder.messages.length);
  });
}

/** Lets every pending promise chain run; the fake server yields on microtasks only. */
async function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

const testAccount: AccountConfig = {
  name: 'test',
  email: 'test@example.com',
  username: 'test@example.com',
  password: 'password',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

// OAuth accounts carry no password: the config schema leaves it empty for oauth2 accounts.
const oauthAccount: AccountConfig = {
  ...testAccount,
  name: 'work',
  password: undefined,
  oauth2: {
    provider: 'google',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
  },
};

const inboxOnly: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };

const running: WatcherService[] = [];

function watch(
  config: WatcherConfig = inboxOnly,
  accounts: AccountConfig[] = [testAccount],
  tokens?: AccessTokenSource,
): { watcher: WatcherService; arrivals: NewEmailEvent[] } {
  const events = new EmailEventBus();
  const arrivals: NewEmailEvent[] = [];
  events.on('email:new', (event) => {
    arrivals.push(event);
  });
  const watcher = new WatcherService(config, accounts, events, tokens);
  running.push(watcher);
  return { watcher, arrivals };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  fake.folders.clear();
  fake.clients.length = 0;
  fake.connectErrors.length = 0;
  fake.loginPending = null;
  seedFolder('INBOX', [38, 40, 41]);
});

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (watcher) => watcher.stop()));
  vi.useRealTimers();
});

describe('WatcherService start', () => {
  it('should not connect when the watcher is disabled', async () => {
    const { watcher } = watch({ ...inboxOnly, enabled: false });
    await watcher.start();
    expect(fake.clients).toHaveLength(0);
  });

  it('should report the newest UID at start as the last one seen', async () => {
    const { watcher } = watch();
    await watcher.start();
    expect(watcher.getStatus()).toEqual([
      { account: 'test', folder: 'INBOX', connected: true, lastSeenUid: 41 },
    ]);
  });

  it('should watch every configured folder', async () => {
    seedFolder('Sent', [3]);
    const { watcher } = watch({ ...inboxOnly, folders: ['INBOX', 'Sent'] });
    await watcher.start();
    expect(watcher.getStatus().map((status) => status.folder)).toEqual(['INBOX', 'Sent']);
  });
});

describe('WatcherService new mail', () => {
  it('should report a message delivered while the connection idles', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(1_000);
    deliver('INBOX', 'Invoice 2026-10');
    await settle();
    expect(arrivals).toMatchObject([
      { account: 'test', mailbox: 'INBOX', emails: [{ id: '42', subject: 'Invoice 2026-10' }] },
    ]);
  });

  it('should report the next message one second after the previous one was fetched', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(1_000);
    deliver('INBOX', 'First');
    await settle();
    await advance(1_000);
    deliver('INBOX', 'Second');
    await settle();
    expect(arrivals.flatMap((arrival) => arrival.emails.map((email) => email.subject))).toEqual([
      'First',
      'Second',
    ]);
  });
});

describe('WatcherService UID range', () => {
  it('should report every message of a burst when UIDs run ahead of sequence numbers', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(1_000);
    deliver('INBOX', 'A', 'B', 'C');
    await settle();
    expect(arrivals.flatMap((arrival) => arrival.emails.map((email) => email.id))).toEqual([
      '42',
      '43',
      '44',
    ]);
  });

  it('should report each message once when notices overlap', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(1_000);
    deliver('INBOX', 'A');
    deliver('INBOX', 'B');
    deliver('INBOX', 'C');
    await settle();
    expect(arrivals.flatMap((arrival) => arrival.emails.map((email) => email.id))).toEqual([
      '42',
      '43',
      '44',
    ]);
  });

  it('should not report the newest message again when the new one is gone before the fetch', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(1_000);
    deliver('INBOX', 'Kept');
    await settle();
    await advance(1_000);
    const [filtered] = deliver('INBOX', 'Filtered by another client');
    expunge('INBOX', [filtered]);
    await settle();
    expect(arrivals.flatMap((arrival) => arrival.emails.map((email) => email.subject))).toEqual([
      'Kept',
    ]);
  });
});

describe('WatcherService resume after a dropped connection', () => {
  it('should report mail that arrived while the connection was down', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    fake.clients[0].close();
    deliver('INBOX', 'While away');
    await advance(1_000);
    expect(arrivals).toMatchObject([{ emails: [{ id: '42', subject: 'While away' }] }]);
  });

  it('should follow the new numbering after the server changed UIDVALIDITY', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    fake.clients[0].close();
    seedFolder('INBOX', [1, 2], 8n);
    await advance(1_000);
    await advance(1_000);
    deliver('INBOX', 'Fresh');
    await settle();
    expect(arrivals.flatMap((arrival) => arrival.emails.map((email) => email.id))).toEqual(['3']);
  });
});

describe('WatcherService OAuth2', () => {
  it('should log in with a token from the token source', async () => {
    const tokens: AccessTokenSource = { getAccessToken: async () => 'ya29.watcher-token' };
    const { watcher } = watch(inboxOnly, [oauthAccount], tokens);
    await watcher.start();
    expect(fake.clients[0].options.auth).toEqual({
      user: 'test@example.com',
      accessToken: 'ya29.watcher-token',
    });
  });

  it('should not open a connection when stop ran during the token refresh', async () => {
    let issueToken = (_token: string): void => {};
    const tokens: AccessTokenSource = {
      getAccessToken: async () =>
        new Promise<string>((resolve) => {
          issueToken = resolve;
        }),
    };
    const { watcher } = watch(inboxOnly, [oauthAccount], tokens);
    const starting = watcher.start();
    await watcher.stop();
    issueToken('ya29.late-token');
    await starting;
    expect(fake.clients).toHaveLength(0);
  });
});

describe('WatcherService failed connect', () => {
  it('should close the connection when the watched folder does not exist', async () => {
    const { watcher } = watch({ ...inboxOnly, folders: ['Archive'] });
    await watcher.start();
    expect(fake.clients[0].closed).toBe(true);
  });

  it('should survive a late error from a connection whose folder failed to open', async () => {
    const { watcher } = watch({ ...inboxOnly, folders: ['Archive'] });
    await watcher.start();
    expect(() => fake.clients[0].emit('error', new Error('read ECONNRESET'))).not.toThrow();
  });
});

describe('WatcherService reconnect', () => {
  it('should try to connect again 1 s after a failed connect', async () => {
    fake.connectErrors.push(new Error('connect ECONNREFUSED'));
    const { watcher } = watch();
    await watcher.start();
    await advance(999);
    expect(fake.clients).toHaveLength(1);
    await advance(1);
    expect(fake.clients).toHaveLength(2);
  });

  it('should double the delay after each failed connect', async () => {
    fake.connectErrors.push(new Error('connect ECONNREFUSED'), new Error('connect ECONNREFUSED'));
    const { watcher } = watch();
    await watcher.start();
    await advance(1_000);
    await advance(1_999);
    expect(fake.clients).toHaveLength(2);
    await advance(1);
    expect(fake.clients).toHaveLength(3);
  });

  it('should not wait longer than 60 s between attempts', async () => {
    fake.connectErrors.push(...Array.from({ length: 7 }, () => new Error('connect ETIMEDOUT')));
    const { watcher } = watch();
    await watcher.start();

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
      // eslint-disable-next-line no-await-in-loop
      await advance(delay);
    }
    await advance(59_999);
    expect(fake.clients).toHaveLength(7);
    await advance(1);
    expect(fake.clients).toHaveLength(8);
  });
});

describe('WatcherService stop', () => {
  it('should log out of the server', async () => {
    const { watcher } = watch();
    await watcher.start();
    await watcher.stop();
    expect(fake.clients[0].loggedOut).toBe(true);
  });

  it('should close a connection that is still logging in', async () => {
    let answerLogin = (): void => {};
    fake.loginPending = new Promise((resolve) => {
      answerLogin = resolve;
    });
    const { watcher } = watch();
    const starting = watcher.start();
    await settle();
    await watcher.stop();
    expect(fake.clients.map((client) => client.closed)).toEqual([true]);
    answerLogin();
    await starting;
  });

  it('should cancel a pending reconnect', async () => {
    fake.connectErrors.push(new Error('connect ECONNREFUSED'));
    const { watcher } = watch();
    await watcher.start();
    await watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('buildEmailMeta', () => {
  it('should take the message id from the envelope', () => {
    const meta = buildEmailMeta({
      uid: 9,
      envelope: {
        subject: 'Hello',
        messageId: '<id@example.com>',
        from: [{ name: 'Ada', address: 'ada@example.com' }],
        to: [{ address: 'bob@example.com' }],
        date: new Date('2026-01-02T00:00:00.000Z'),
      },
    });
    expect(meta).toMatchObject({ id: '9', subject: 'Hello', messageId: '<id@example.com>' });
  });
});
