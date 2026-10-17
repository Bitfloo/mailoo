import { ImapFlow } from 'imapflow';

import type { NewEmailEvent } from '../services/event-bus.js';
import { EmailEventBus } from '../services/event-bus.js';
import WatcherService from '../services/watcher.service.js';
import type { WatcherConfig } from '../types/index.js';
import {
  buildTestAccount,
  getGreenMailPorts,
  seedEmail,
  waitForDelivery,
} from './helpers/index.js';

/** The watcher enters IDLE about a second after it opens the folder. */
const IDLE_START_MS = 1_500;
/** A real-time notice has to beat this, measured from the moment SMTP accepted the message. */
const ARRIVAL_DEADLINE_MS = 5_000;

const inbox: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };

const running: WatcherService[] = [];

function startWatcher(): { watcher: WatcherService; subjects: () => string[] } {
  const events = new EmailEventBus();
  const arrivals: NewEmailEvent[] = [];
  events.on('email:new', (event) => {
    arrivals.push(event);
  });
  const watcher = new WatcherService(inbox, [buildTestAccount()], events);
  running.push(watcher);
  return {
    watcher,
    subjects: () => arrivals.flatMap((arrival) => arrival.emails.map((email) => email.subject)),
  };
}

/** Deletes and expunges through a second session, so later UIDs run ahead of sequence numbers. */
async function expungeBySubject(subject: string): Promise<number> {
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
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ subject }, { uid: true })) || [];
      if (uids.length > 0) await client.messageDelete(uids, { uid: true });
      return uids.length;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (watcher) => watcher.stop()));
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
    await Promise.all(burst.map(async (subject) => seedEmail({ subject })));

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
