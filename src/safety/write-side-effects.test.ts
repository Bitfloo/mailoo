import { maybeStartMailboxWriters } from './write-side-effects.js';

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  return (await Promise.race([promise, Promise.resolve(marker)])) !== marker;
}

describe('maybeStartMailboxWriters', () => {
  it('does not start hooks, watcher, or scheduler when canWrite is false', async () => {
    const startHooks = vi.fn();
    const startWatcher = vi.fn().mockResolvedValue(undefined);
    const startScheduler = vi.fn().mockResolvedValue(undefined);

    const started = await maybeStartMailboxWriters(false, {
      startHooks,
      startWatcher,
      startScheduler,
    });

    expect(started).toBe(false);
    expect(startHooks).not.toHaveBeenCalled();
    expect(startWatcher).not.toHaveBeenCalled();
    expect(startScheduler).not.toHaveBeenCalled();
  });

  it('starts hooks, watcher, and scheduler when canWrite is true', async () => {
    const startHooks = vi.fn();
    const startWatcher = vi.fn().mockResolvedValue(undefined);
    const startScheduler = vi.fn().mockResolvedValue(undefined);

    const started = await maybeStartMailboxWriters(true, {
      startHooks,
      startWatcher,
      startScheduler,
    });

    expect(started).toBe(true);
    expect(startHooks).toHaveBeenCalledOnce();
    expect(startWatcher).toHaveBeenCalledOnce();
    expect(startScheduler).toHaveBeenCalledOnce();
  });

  it('should start the scheduler while the watcher is still connecting', async () => {
    const started: string[] = [];
    // A watcher connect can wait out the IMAP connection timeout for every folder.
    const pending = maybeStartMailboxWriters(true, {
      startWatcher: async () => {
        started.push('watcher');
        await new Promise(() => {});
      },
      startScheduler: () => {
        started.push('scheduler');
      },
    });
    await Promise.resolve();
    expect({ started: [...started].sort(), settled: await isSettled(pending) }).toEqual({
      started: ['scheduler', 'watcher'],
      settled: false,
    });
  });
});
