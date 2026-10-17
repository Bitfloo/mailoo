import type { EventEmitter } from 'node:events';

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

    private idleTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(readonly options: Record<string, unknown> & { auth: Record<string, unknown> }) {
      super();
      fake.clients.push(this);
    }

    async connect(): Promise<void> {
      await Promise.resolve();
      if (this.closed) throw new Error('Connection closed');
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
      await this.command();
      if (!this.mailbox || this.mailbox.path !== path) this.select(path);
      this.locksHeld += 1;
      clearTimeout(this.idleTimer);
      let released = false;
      return {
        path,
        release: () => {
          if (released) return;
          released = true;
          this.locksHeld -= 1;
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

const inboxOnly: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };

const running: WatcherService[] = [];

function watch(
  config: WatcherConfig = inboxOnly,
  accounts: AccountConfig[] = [testAccount],
): { watcher: WatcherService; arrivals: NewEmailEvent[] } {
  const events = new EmailEventBus();
  const arrivals: NewEmailEvent[] = [];
  events.on('email:new', (event) => {
    arrivals.push(event);
  });
  const watcher = new WatcherService(config, accounts, events);
  running.push(watcher);
  return { watcher, arrivals };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  fake.folders.clear();
  fake.clients.length = 0;
  fake.connectErrors.length = 0;
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
