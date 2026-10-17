/**
 * In-memory IMAP server for the watcher suites, standing in for imapflow. A suite wires it in
 * with `vi.mock('imapflow', async () => ({ ImapFlow: (await import(...)).FakeImapFlow }))`.
 * Imports nothing that loads imapflow, so the mock factory can load it without a cycle.
 */

import { EventEmitter } from 'node:events';

interface FakeMessage {
  uid: number;
  subject: string;
}

interface FakeFolder {
  uidValidity: bigint;
  uidNext: number;
  messages: FakeMessage[];
}

interface FakeMailbox {
  path: string;
  uidValidity: bigint;
  uidNext: number;
  exists: number;
}

interface FakeFetchedMessage {
  seq: number;
  uid: number;
  flags: Set<string>;
  envelope: { subject: string; from: { address: string }[]; date: Date };
}

type FakeOptions = Record<string, unknown> & { auth: Record<string, unknown> };

// imapflow's default wait before it starts IDLE on a free connection.
const AUTO_IDLE_DEFAULT_MS = 15_000;

/** Server state shared by every fake connection. */
export const fake = {
  folders: new Map<string, FakeFolder>(),
  clients: [] as FakeImapFlow[],
  // Errors the next connect() calls reject with, in order; empty means success.
  connectErrors: [] as Error[],
  // While set, connect() waits for it: a login the server has not answered yet.
  loginPending: null as Promise<void> | null,
  // Errors the next fetch() calls fail with, in order. A `NoConnection` one drops the connection
  // first, as imapflow closes before it fails the command that was in flight.
  fetchErrors: [] as Error[],
};

/**
 * Follows imapflow where the watcher depends on it: IDLE starts only once the connection has
 * been free (no lock held, no command running) for `autoIdleDelay`, the server pushes EXISTS
 * only while idling or in a command response, and fetch reads its range as UIDs only when the
 * third argument says `{ uid: true }`.
 */
export class FakeImapFlow extends EventEmitter {
  usable = false;

  closed = false;

  loggedOut = false;

  fetchCount = 0;

  mailbox: false | FakeMailbox = false;

  private locksHeld = 0;

  private idling = false;

  private knownCount = 0;

  // imapflow grants mailbox locks one at a time, in request order.
  private lockQueue: Promise<void> = Promise.resolve();

  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  // Set while connect() is pending; failing the login goes through it.
  private failLogin: ((err: Error) => void) | undefined;

  constructor(readonly options: FakeOptions) {
    super();
    fake.clients.push(this);
  }

  async connect(): Promise<void> {
    const failed = new Promise<never>((_resolve, reject) => {
      this.failLogin = reject;
    });
    try {
      await Promise.race([fake.loginPending ?? Promise.resolve(), failed]);
    } finally {
      this.failLogin = undefined;
    }
    const error = fake.connectErrors.shift();
    // Like imapflow, a rejected login leaves the socket open.
    if (error) throw error;
    this.usable = true;
  }

  /**
   * A socket error, routed as imapflow 1.7's emitError() routes it: while connect() is pending
   * it rejects that promise and emits no 'error' event; after that it emits 'error'. Either way
   * the connection closes on the next turn of the event loop.
   */
  socketError(err: Error): void {
    setImmediate(() => {
      this.shutdown();
    });
    if (this.failLogin) {
      this.failLogin(err);
      return;
    }
    this.emit('error', err);
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

  fetch = async function* fetchMessages(
    this: FakeImapFlow,
    range: string,
    _query: Record<string, unknown>,
    options?: { uid?: boolean },
  ): AsyncGenerator<FakeFetchedMessage> {
    this.fetchCount += 1;
    await this.command();
    const error = fake.fetchErrors.shift();
    if (error) {
      if ((error as { code?: string }).code === 'NoConnection') this.shutdown();
      throw error;
    }
    const folder = this.mailbox ? fake.folders.get(this.mailbox.path) : undefined;
    if (!folder) throw new Error('No mailbox selected');
    const field = options?.uid === true ? 'uid' : 'seq';
    const numbered = folder.messages.map((message, index) => ({ ...message, seq: index + 1 }));
    const highest = numbered.at(-1)?.[field] ?? 0;
    // IMAP reads `N:*` as the span between N and the highest number, so it still matches the
    // newest message when N is past it.
    const low = Math.min(Number(range.split(':')[0]), highest);
    const matched = highest > 0 ? numbered.filter((message) => message[field] >= low) : [];
    yield* matched.map((message) => ({
      seq: message.seq,
      uid: message.uid,
      flags: new Set<string>(),
      envelope: {
        subject: message.subject,
        from: [{ address: 'sender@example.com' }],
        date: new Date('2026-10-01T08:00:00.000Z'),
      },
    }));
    this.armIdle();
  };

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
    // imapflow's close() rejects a pending connect() with this message, then emits 'close'.
    this.failLogin?.(new Error('Unexpected close'));
    this.emit('close');
  }
}

export function resetFakeServer(): void {
  fake.folders.clear();
  fake.clients.length = 0;
  fake.connectErrors.length = 0;
  fake.loginPending = null;
  fake.fetchErrors.length = 0;
}

/** UIDs with gaps, as left behind by earlier expunges, so UIDs and sequence numbers differ. */
export function seedFolder(path: string, uids: number[], uidValidity = 7n): void {
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
export function deliver(path: string, ...subjects: string[]): number[] {
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

export function expunge(path: string, uids: number[]): void {
  const folder = folderAt(path);
  const before = folder.messages.length;
  folder.messages = folder.messages.filter((message) => !uids.includes(message.uid));
  fake.clients.forEach((client) => {
    client.noteExpunge(path, before - folder.messages.length);
  });
}

/** Lets every pending promise chain run; the fake server yields on microtasks only. */
export async function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}
