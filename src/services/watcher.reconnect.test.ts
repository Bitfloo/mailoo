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
