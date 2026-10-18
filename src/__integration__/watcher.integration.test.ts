import type { Socket } from 'node:net';

import { ImapFlow } from 'imapflow';

import { INITIAL_BACKOFF_MS, JITTER_RATIO } from '../connections/backoff.js';
import type { NewEmailEvent } from '../services/event-bus.js';
import { EmailEventBus } from '../services/event-bus.js';
import WatcherService, { AUTO_IDLE_DELAY_MS } from '../services/watcher.service.js';
import type { AccountConfig, EmailMeta, WatcherConfig } from '../types/index.js';
import {
  buildTestAccount,
  getGreenMailPorts,
  seedEmail,
  waitForDelivery,
} from './helpers/index.js';

/** Room for the IMAP round trips (login, folder select) GreenMail answers before a timed step. */
const ROUND_TRIP_SLACK_MS = 500;
/** The watcher enters IDLE once the opened folder has been quiet for the auto-IDLE delay. */
const IDLE_START_MS = AUTO_IDLE_DELAY_MS + ROUND_TRIP_SLACK_MS;
/** A real-time notice has to beat this, measured from the moment SMTP accepted the message. */
const ARRIVAL_DEADLINE_MS = 5_000;
/** The first retry follows a refusal by the first backoff, shortened by up to the jitter. */
const FIRST_RETRY_MIN_MS = INITIAL_BACKOFF_MS * (1 - JITTER_RATIO);
const FIRST_RETRY_MAX_MS = INITIAL_BACKOFF_MS + ROUND_TRIP_SLACK_MS;
/** After the second failure the next attempt is 1.5 s to 2 s away, so sockets must be gone by then. */
const SOCKET_RELEASE_DEADLINE_MS = 1_000;
/** Long enough for a duplicate report to show up after the first one. */
const DUPLICATE_WINDOW_MS = 2_500;

const inbox: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };

const running: WatcherService[] = [];

function startWatcher(
  config: WatcherConfig = inbox,
  account: AccountConfig = buildTestAccount(),
): { watcher: WatcherService; emails: () => EmailMeta[]; subjects: () => string[] } {
  const events = new EmailEventBus();
  const arrivals: NewEmailEvent[] = [];
  events.on('email:new', (event) => {
    arrivals.push(event);
  });
  const watcher = new WatcherService(config, [account], events);
  running.push(watcher);
  const emails = (): EmailMeta[] => arrivals.flatMap((arrival) => arrival.emails);
  return { watcher, emails, subjects: () => emails().map((email) => email.subject) };
}

/** Works on the test mailbox the way another mail client would, beside the watcher's session. */
async function inSecondSession<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const { host, imapPort } = getGreenMailPorts();
  const client = new ImapFlow({
    host,
    port: imapPort,
    secure: false,
    auth: { user: 'test', pass: 'test' },
    logger: false,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.logout();
  }
}

/** Deletes and expunges through a second session, so later UIDs run ahead of sequence numbers. */
async function expungeBySubject(subject: string): Promise<number> {
  return inSecondSession(async (client) => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ subject }, { uid: true })) || [];
      if (uids.length > 0) await client.messageDelete(uids, { uid: true });
      return uids.length;
    } finally {
      lock.release();
    }
  });
}

/** A text message with a PDF attached, as a mail client sends it. */
function invoiceSource(subject: string): string {
  return [
    'From: billing@example.com',
    'To: test@localhost',
    `Subject: ${subject}`,
    `Message-ID: <${subject}@example.com>`,
    'Date: Thu, 01 Oct 2026 08:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="invoice"',
    '',
    '--invoice',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Your invoice is attached.',
    '--invoice',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64'),
    '--invoice--',
    '',
  ].join('\r\n');
}

interface ConnectAttempt {
  client: ImapFlow;
  at: number;
}

/** Records every ImapFlow connect() the watcher makes, then lets the real one run. */
function recordConnects(): ConnectAttempt[] {
  const attempts: ConnectAttempt[] = [];
  const { connect } = ImapFlow.prototype;
  vi.spyOn(ImapFlow.prototype, 'connect').mockImplementation(async function recorded(
    this: ImapFlow,
  ) {
    attempts.push({ client: this, at: Date.now() });
    return connect.call(this);
  });
  return attempts;
}

function openSockets(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'TCPSocketWrap').length;
}

/** GreenMail cannot end a session from the server side, so the test cuts the client's socket. */
function dropSession(client: ImapFlow): void {
  (client as unknown as { socket: Socket | null }).socket?.destroy();
}

const crashes: unknown[] = [];
const recordCrash = (err: unknown): void => {
  crashes.push(err);
};

beforeEach(() => {
  crashes.length = 0;
  process.on('uncaughtException', recordCrash);
  process.on('unhandledRejection', recordCrash);
});

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (watcher) => watcher.stop()));
  process.off('uncaughtException', recordCrash);
  process.off('unhandledRejection', recordCrash);
  vi.restoreAllMocks();
});

describe('WatcherService on a live IMAP server', () => {
  it('should report a delivered message within a few seconds', async () => {
    const { watcher, subjects } = startWatcher();
    await watcher.start();
    await waitForDelivery(IDLE_START_MS);

    const subject = `watcher-single-${Date.now()}`;
    await seedEmail({ subject });

    await vi.waitFor(
      () => {
        expect(subjects()).toContain(subject);
      },
      { timeout: ARRIVAL_DEADLINE_MS, interval: 50 },
    );
  });

  // Filed with \Seen in the same APPEND, so the watcher's fetch can only see it read: a STORE
  // after an SMTP delivery would race that fetch.
  it('should report a message another client filed as read with its attachment flag', async () => {
    const { watcher, emails } = startWatcher();
    await watcher.start();
    await waitForDelivery(IDLE_START_MS);

    const subject = `watcher-read-${Date.now()}`;
    await inSecondSession(async (client) =>
      client.append('INBOX', invoiceSource(subject), ['\\Seen']),
    );

    await vi.waitFor(
      () => {
        expect(emails().find((email) => email.subject === subject)).toMatchObject({
          seen: true,
          hasAttachments: true,
        });
      },
      { timeout: ARRIVAL_DEADLINE_MS, interval: 50 },
    );
  });

  it('should report all three messages of a burst after deletes moved UIDs past sequence numbers', async () => {
    const marker = `watcher-burst-${Date.now()}`;
    // eslint-disable-next-line no-restricted-syntax -- one message at a time keeps their order
    for (const n of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      await seedEmail({ subject: `${marker}-old-${n}` });
    }
    await waitForDelivery();
    expect(await expungeBySubject(`${marker}-old`)).toBe(3);

    const { watcher, subjects } = startWatcher();
    await watcher.start();
    await waitForDelivery(IDLE_START_MS);

    const burst = [1, 2, 3].map((n) => `${marker}-new-${n}`);
    // eslint-disable-next-line no-restricted-syntax -- concurrent SMTP sessions make GreenMail drop or stall the idling session
    for (const subject of burst) {
      // eslint-disable-next-line no-await-in-loop
      await seedEmail({ subject });
    }

    await vi.waitFor(
      () => {
        expect(
          subjects()
            .filter((subject) => subject.startsWith(`${marker}-new`))
            .sort(),
        ).toEqual(burst);
      },
      { timeout: ARRIVAL_DEADLINE_MS, interval: 50 },
    );
  });
});

type Refusal = [string, () => { config: WatcherConfig; account: AccountConfig }];

const refusals: Refusal[] = [
  [
    'the password is wrong',
    () => ({ config: inbox, account: buildTestAccount({ password: 'wrong-password' }) }),
  ],
  [
    'the folder does not exist',
    () => ({ config: { ...inbox, folders: ['Missing-Folder'] }, account: buildTestAccount() }),
  ],
];

async function waitForSecondAttempt(attempts: ConnectAttempt[]): Promise<void> {
  await vi.waitFor(
    () => {
      expect(attempts).toHaveLength(2);
    },
    { timeout: FIRST_RETRY_MAX_MS * 2, interval: 20 },
  );
}

describe('WatcherService against refusals from a live IMAP server', () => {
  it.each(refusals)('should retry about 1 s after the first refusal when %s', async (_, setup) => {
    const { config, account } = setup();
    const attempts = recordConnects();
    const { watcher } = startWatcher(config, account);
    await watcher.start();
    await waitForSecondAttempt(attempts);
    const gap = attempts[1].at - attempts[0].at;
    expect(gap).toBeGreaterThanOrEqual(FIRST_RETRY_MIN_MS);
    expect(gap).toBeLessThan(FIRST_RETRY_MAX_MS);
  });

  it.each(refusals)('should leave no socket open after a refusal when %s', async (_, setup) => {
    const { config, account } = setup();
    const before = openSockets();
    const attempts = recordConnects();
    const { watcher } = startWatcher(config, account);
    await watcher.start();
    await waitForSecondAttempt(attempts);
    await vi.waitFor(
      () => {
        expect(openSockets()).toBeLessThanOrEqual(before);
      },
      { timeout: SOCKET_RELEASE_DEADLINE_MS, interval: 20 },
    );
  });

  it.each(refusals)('should raise no uncaught error while it retries when %s', async (_, setup) => {
    const { config, account } = setup();
    const attempts = recordConnects();
    const { watcher } = startWatcher(config, account);
    await watcher.start();
    await waitForSecondAttempt(attempts);
    expect(crashes).toEqual([]);
  });
});

describe('WatcherService after a dropped session', () => {
  it('should report mail delivered during the outage exactly once', async () => {
    const attempts = recordConnects();
    const { watcher, subjects } = startWatcher();
    await watcher.start();
    await waitForDelivery(IDLE_START_MS);

    dropSession(attempts[0].client);
    // Down before SMTP takes the message, with the retry at least FIRST_RETRY_MIN_MS away, so
    // the message normally lands while no session is open and only the catch-up can report it.
    await vi.waitFor(
      () => {
        expect(watcher.getStatus()[0].connected).toBe(false);
      },
      { timeout: FIRST_RETRY_MIN_MS, interval: 10 },
    );
    const subject = `watcher-outage-${Date.now()}`;
    await seedEmail({ subject });

    await vi.waitFor(
      () => {
        expect(subjects()).toContain(subject);
      },
      { timeout: ARRIVAL_DEADLINE_MS, interval: 50 },
    );
    await waitForDelivery(DUPLICATE_WINDOW_MS);
    expect(subjects().filter((reported) => reported === subject)).toEqual([subject]);
  });
});
