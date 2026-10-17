import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  tearDownWatchers,
  testAccount,
  watch,
} from '../test-support/watcher-harness.js';
import { AUTO_IDLE_DELAY_MS } from './watcher.service.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

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

afterEach(tearDownWatchers);

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

describe('WatcherService with two accounts', () => {
  const otherAccount = { ...testAccount, name: 'other', username: 'other@example.com' };

  it('should list the same folder of two accounts separately', async () => {
    const { watcher } = watch(inboxOnly, [testAccount, otherAccount]);
    await watcher.start();
    expect(watcher.getStatus().map((status) => `${status.account}/${status.folder}`)).toEqual([
      'test/INBOX',
      'other/INBOX',
    ]);
  });

  it('should report a delivery once to each account watching that folder', async () => {
    const { watcher, arrivals } = watch(inboxOnly, [testAccount, otherAccount]);
    await watcher.start();
    await advance(AUTO_IDLE_DELAY_MS);
    // The in-memory server has one folder tree, so both accounts see the same INBOX.
    deliver('INBOX', 'Shared');
    await settle();
    expect(arrivals.map((arrival) => arrival.account).sort()).toEqual(['other', 'test']);
  });
});

describe('WatcherService new mail', () => {
  it('should report a message delivered while the connection idles', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(AUTO_IDLE_DELAY_MS);
    deliver('INBOX', 'Invoice 2026-10');
    await settle();
    expect(arrivals).toMatchObject([
      { account: 'test', mailbox: 'INBOX', emails: [{ id: '42', subject: 'Invoice 2026-10' }] },
    ]);
  });

  it('should report the next message one second after the previous one was fetched', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(AUTO_IDLE_DELAY_MS);
    deliver('INBOX', 'First');
    await settle();
    await advance(AUTO_IDLE_DELAY_MS);
    deliver('INBOX', 'Second');
    await settle();
    expect(arrivedSubjects(arrivals)).toEqual(['First', 'Second']);
  });
  it('should not fetch when the message count went down', async () => {
    const { watcher } = watch();
    await watcher.start();
    await advance(AUTO_IDLE_DELAY_MS);
    // imapflow raises exists on any change of the count, so a shrink reaches the handler too.
    fake.clients[0].emit('exists', { path: 'INBOX', count: 2, prevCount: 3 });
    await settle();
    expect(fake.clients[0].fetchCount).toBe(0);
  });
});

describe('WatcherService arrival folder', () => {
  it('should name the folder an arrival came from', async () => {
    seedFolder('Sent', [3]);
    const { watcher, arrivals } = watch({ ...inboxOnly, folders: ['INBOX', 'Sent'] });
    await watcher.start();
    await advance(AUTO_IDLE_DELAY_MS);
    deliver('Sent', 'Re: Invoice 2026-10');
    await settle();
    expect(arrivals).toMatchObject([
      { mailbox: 'Sent', emails: [{ subject: 'Re: Invoice 2026-10' }] },
    ]);
  });
});

describe('WatcherService failed fetch', () => {
  it('should report the next message after a fetch failed', async () => {
    fake.fetchErrors.push(new Error('Command failed'));
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(AUTO_IDLE_DELAY_MS);
    deliver('INBOX', 'Lost');
    await settle();
    await advance(AUTO_IDLE_DELAY_MS);
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
    await advance(AUTO_IDLE_DELAY_MS);
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
    await advance(AUTO_IDLE_DELAY_MS);
    deliver('INBOX', 'A', 'B', 'C');
    await settle();
    expect(arrivedIds(arrivals)).toEqual(['42', '43', '44']);
  });

  it('should report each message once when notices overlap', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(AUTO_IDLE_DELAY_MS);
    deliver('INBOX', 'A');
    deliver('INBOX', 'B');
    deliver('INBOX', 'C');
    await settle();
    expect(arrivedIds(arrivals)).toEqual(['42', '43', '44']);
  });

  it('should not report the newest message again when the new one is gone before the fetch', async () => {
    const { watcher, arrivals } = watch();
    await watcher.start();
    await advance(AUTO_IDLE_DELAY_MS);
    deliver('INBOX', 'Kept');
    await settle();
    await advance(AUTO_IDLE_DELAY_MS);
    const [filtered] = deliver('INBOX', 'Filtered by another client');
    expunge('INBOX', [filtered]);
    await settle();
    // Matched whole, not flattened to subjects: an event with no emails must fail too.
    expect(arrivals).toMatchObject([{ emails: [{ subject: 'Kept' }] }]);
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

describe('WatcherService reconnect timer', () => {
  it('should not keep the process alive for a pending reconnect', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    fake.connectErrors.push(new Error('connect ECONNREFUSED'));
    const { watcher } = watch();
    await watcher.start();
    const reconnect = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1_000);
    const timer = setTimeoutSpy.mock.results[reconnect]?.value as NodeJS.Timeout | undefined;
    expect(timer?.hasRef()).toBe(false);
  });

  // Spies and tears down itself, so no test order or filter can skip the check. A teardown that
  // left the fake setTimeout on globalThis would make this timer never fire.
  it('should have real timers again after a test that spied on setTimeout', async () => {
    vi.spyOn(globalThis, 'setTimeout');
    await tearDownWatchers();
    const fired = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 5);
    });
    expect(fired).toBe(true);
  });
});

describe('README watcher section', () => {
  it('should state how soon IDLE resumes after a fetch', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    // The README words the delay, so a new delay needs new wording there and here.
    const wording: Record<number, string> = { 1000: 'a second' };
    expect(readme).toContain(`IDLE resumes about ${wording[AUTO_IDLE_DELAY_MS]} after each fetch`);
  });
});
