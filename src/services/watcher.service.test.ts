import type { AccessTokenSource } from '../connections/types.js';
import {
  advance,
  deliver,
  expunge,
  fake,
  resetFakeServer,
  seedFolder,
  settle,
} from '../test-support/fake-imapflow.js';
import {
  arrivedIds,
  arrivedSubjects,
  inboxOnly,
  oauthAccount,
  stopWatchers,
  watch,
} from '../test-support/watcher-harness.js';
import { buildEmailMeta } from './watcher.service.js';

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

  it('should end each IDLE after idleTimeout, given in seconds', async () => {
    const { watcher } = watch();
    await watcher.start();
    expect(fake.clients[0].options.maxIdleTime).toBe(1_740_000);
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
    expect(arrivedSubjects(arrivals)).toEqual(['First', 'Second']);
  });
  it('should not fetch when the message count went down', async () => {
    const { watcher } = watch();
    await watcher.start();
    await advance(1_000);
    // imapflow raises exists on any change of the count, so a shrink reaches the handler too.
    fake.clients[0].emit('exists', { path: 'INBOX', count: 2, prevCount: 3 });
    await settle();
    expect(fake.clients[0].fetchCount).toBe(0);
  });
});

describe('WatcherService failed fetch', () => {
  it('should report the next message after a fetch failed', async () => {
    fake.fetchErrors.push(new Error('Command failed'));
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(1_000);
    deliver('INBOX', 'Lost');
    await settle();
    await advance(1_000);
    deliver('INBOX', 'Next');
    await settle();
    expect(arrivedSubjects(arrivals)).toEqual(['Lost', 'Next']);
  });

  it('should report a message once after the connection dropped while fetching it', async () => {
    fake.fetchErrors.push(
      Object.assign(new Error('Connection not available'), { code: 'NoConnection' }),
    );
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(1_000);
    deliver('INBOX', 'Mid-fetch');
    await settle();
    await advance(1_000);
    await advance(1_000);
    expect(arrivedSubjects(arrivals)).toEqual(['Mid-fetch']);
  });
});

describe('WatcherService UID range', () => {
  it('should report every message of a burst when UIDs run ahead of sequence numbers', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(1_000);
    deliver('INBOX', 'A', 'B', 'C');
    await settle();
    expect(arrivedIds(arrivals)).toEqual(['42', '43', '44']);
  });

  it('should report each message once when notices overlap', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(1_000);
    deliver('INBOX', 'A');
    deliver('INBOX', 'B');
    deliver('INBOX', 'C');
    await settle();
    expect(arrivedIds(arrivals)).toEqual(['42', '43', '44']);
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
    expect(arrivedSubjects(arrivals)).toEqual(['Kept']);
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

  it('should leave no timer running after it logged out of a live connection', async () => {
    const { watcher } = watch();
    await watcher.start();
    await watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should list no folders once stopped', async () => {
    const { watcher } = watch();
    await watcher.start();
    await watcher.stop();
    expect(watcher.getStatus()).toEqual([]);
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
