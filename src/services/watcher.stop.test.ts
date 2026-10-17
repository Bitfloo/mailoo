import { fake, resetFakeServer, seedFolder, settle } from '../test-support/fake-imapflow.js';
import { tearDownWatchers, watch } from '../test-support/watcher-harness.js';

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

  it('should leave no reconnect pending after it closed a connection still logging in', async () => {
    let answerLogin = (): void => {};
    fake.loginPending = new Promise((resolve) => {
      answerLogin = resolve;
    });
    const { watcher } = watch();
    const starting = watcher.start();
    await settle();
    await watcher.stop();
    answerLogin();
    await starting;
    expect(vi.getTimerCount()).toBe(0);
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
