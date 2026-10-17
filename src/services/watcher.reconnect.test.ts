import {
  advance,
  deliver,
  fake,
  resetFakeServer,
  seedFolder,
  settle,
} from '../test-support/fake-imapflow.js';
import { arrivedIds, inboxOnly, stopWatchers, watch } from '../test-support/watcher-harness.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('imapflow', async () => ({
  ImapFlow: (await import('../test-support/fake-imapflow.js')).FakeImapFlow,
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // Reconnect jitter at zero, so every delay below is the full backoff.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  resetFakeServer();
  seedFolder('INBOX', [38, 40, 41]);
});

afterEach(async () => {
  await stopWatchers();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(arrivedIds(arrivals)).toEqual(['3']);
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

  it('should start from the mail already in a folder whose first connect failed', async () => {
    fake.connectErrors.push(new Error('connect ECONNREFUSED'));
    const { watcher, arrivals } = watch();
    await watcher.start();
    deliver('INBOX', 'Before the first connect');
    await advance(1_000);
    await advance(1_000);
    expect(arrivedIds(arrivals)).toEqual([]);
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

describe('WatcherService reconnect jitter', () => {
  it('should retry up to a quarter early so folders do not reconnect in lockstep', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999_999);
    fake.connectErrors.push(new Error('connect ECONNREFUSED'));
    const { watcher } = watch();
    await watcher.start();
    await advance(750);
    expect(fake.clients).toHaveLength(1);
    await advance(1);
    expect(fake.clients).toHaveLength(2);
  });
});

/** Holds the next logins unanswered; the returned function answers them. */
function holdLogin(): () => void {
  let answer = (): void => {};
  fake.loginPending = new Promise((resolve) => {
    answer = resolve;
  });
  return () => {
    fake.loginPending = null;
    answer();
  };
}

describe('WatcherService listeners bound before connect', () => {
  it('should already have an error listener while the login is pending', async () => {
    const answerLogin = holdLogin();
    const { watcher } = watch();
    const starting = watcher.start();
    await settle();
    // Emitted directly: imapflow itself reports a socket error during login through connect().
    expect(() => fake.clients[0].emit('error', new Error('read ECONNRESET'))).not.toThrow();
    answerLogin();
    await starting;
  });

  it('should make one new attempt when a close during login reaches both its listener and the failed connect', async () => {
    const answerLogin = holdLogin();
    const { watcher } = watch();
    const starting = watcher.start();
    await settle();
    fake.clients[0].close();
    answerLogin();
    await starting;
    await advance(60_000);
    expect(fake.clients).toHaveLength(2);
  });
});

describe('WatcherService socket error during login', () => {
  it('should connect again 1 s after a socket error failed the pending login', async () => {
    const answerLogin = holdLogin();
    const { watcher } = watch();
    const starting = watcher.start();
    await settle();
    fake.clients[0].socketError(new Error('read ECONNRESET'));
    answerLogin();
    await starting;
    await advance(1_000);
    expect(fake.clients.map((client) => client.usable)).toEqual([false, true]);
  });
});

describe('WatcherService after a successful reconnect', () => {
  it('should wait 1 s again when a connection that followed failures drops', async () => {
    fake.connectErrors.push(new Error('connect ECONNREFUSED'), new Error('connect ECONNREFUSED'));
    const { watcher } = watch();
    await watcher.start();
    await advance(1_000);
    await advance(2_000);
    fake.clients[2].close();
    await advance(999);
    expect(fake.clients).toHaveLength(3);
    await advance(1);
    expect(fake.clients).toHaveLength(4);
  });

  it('should not reconnect when the connection it replaced reports a late close', async () => {
    fake.connectErrors.push(new Error('Invalid credentials'));
    const { watcher } = watch();
    await watcher.start();
    await advance(1_000);
    fake.clients[0].emit('close');
    await advance(60_000);
    expect(fake.clients).toHaveLength(2);
  });

  it('should stay connected when the connection it replaced reports a late error', async () => {
    fake.connectErrors.push(new Error('Invalid credentials'));
    const { watcher } = watch();
    await watcher.start();
    await advance(1_000);
    fake.clients[0].emit('error', new Error('read ECONNRESET'));
    expect(watcher.getStatus()[0].connected).toBe(true);
  });
});

describe('WatcherService status', () => {
  it('should report the folder disconnected while its login is pending', async () => {
    const answerLogin = holdLogin();
    const { watcher } = watch();
    const starting = watcher.start();
    await settle();
    expect(watcher.getStatus()[0].connected).toBe(false);
    answerLogin();
    await starting;
    expect(watcher.getStatus()[0].connected).toBe(true);
  });

  it('should report the folder disconnected as soon as its connection drops', async () => {
    const { watcher } = watch();
    await watcher.start();
    fake.clients[0].close();
    expect(watcher.getStatus()[0].connected).toBe(false);
  });
});
