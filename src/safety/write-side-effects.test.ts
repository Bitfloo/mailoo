import { maybeStartMailboxWriters } from './write-side-effects.js';

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
});
