import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImapFlow } from 'imapflow';
import lockMailbox, { MAILBOX_LOCK_TIMEOUT_MS } from './mailbox-lock.js';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Files allowed to call getMailboxLock directly. The watcher owns a dedicated
 * IDLE connection that no tool call queues behind.
 */
const DIRECT_LOCK_CALLERS = new Set(['services/mailbox-lock.ts', 'services/watcher.service.ts']);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
    }),
  );
  return nested.flat();
}

/**
 * getMailboxLock with imapflow's acquireTimeout contract: a request that is
 * never granted rejects with code LockTimeout after acquireTimeout ms, and
 * without the option it waits forever. The held lock is never released here.
 */
function clientWithHeldLock() {
  const getMailboxLock = vi.fn(
    async (_path: string, options?: { acquireTimeout?: number }) =>
      new Promise<never>((_resolve, reject) => {
        if (!options?.acquireTimeout) return;
        setTimeout(() => {
          const err = Object.assign(new Error('Timed out waiting for mailbox lock'), {
            code: 'LockTimeout',
          });
          reject(err);
        }, options.acquireTimeout);
      }),
  );
  return { getMailboxLock } as unknown as ImapFlow;
}

describe('lockMailbox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should reject with a busy-mailbox error when the lock is not granted in time', async () => {
    const pending = lockMailbox(clientWithHeldLock(), 'INBOX');
    const outcome = expect(pending).rejects.toThrow(
      'Mailbox "INBOX" stayed busy for 60 s: an earlier operation on this account has not finished.',
    );

    await vi.advanceTimersByTimeAsync(MAILBOX_LOCK_TIMEOUT_MS);

    await outcome;
  });

  it('should still be waiting for the lock just before the timeout', async () => {
    let settled = false;
    lockMailbox(clientWithHeldLock(), 'INBOX').then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(MAILBOX_LOCK_TIMEOUT_MS - 1);

    expect(settled).toBe(false);
  });

  it('should keep the imapflow LockTimeout error as the cause', async () => {
    const pending = lockMailbox(clientWithHeldLock(), 'INBOX').catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(MAILBOX_LOCK_TIMEOUT_MS);

    expect(((await pending) as Error).cause).toMatchObject({ code: 'LockTimeout' });
  });

  // The one literal pin of the acquireTimeout option; the other suites read MAILBOX_LOCK_TIMEOUT_MS.
  it('should open the mailbox read-only with a 60 s acquire timeout when asked to', async () => {
    const getMailboxLock = vi.fn().mockResolvedValue({ path: 'Archive', release: vi.fn() });

    await lockMailbox({ getMailboxLock } as unknown as ImapFlow, 'Archive', { readOnly: true });

    expect(getMailboxLock).toHaveBeenCalledWith('Archive', {
      readOnly: true,
      acquireTimeout: 60_000,
    });
  });

  it('should pass any other lock error through unchanged', async () => {
    const failure = new Error('Mailbox does not exist');
    const client = { getMailboxLock: vi.fn().mockRejectedValue(failure) } as unknown as ImapFlow;

    await expect(lockMailbox(client, 'Gone')).rejects.toBe(failure);
  });

  // A dropped connection is not a busy mailbox; reporting it as one hides the real fault.
  it('should pass an imapflow error with another code through unchanged', async () => {
    const failure = Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    const client = { getMailboxLock: vi.fn().mockRejectedValue(failure) } as unknown as ImapFlow;

    await expect(lockMailbox(client, 'INBOX')).rejects.toBe(failure);
  });
});

describe('mailbox lock call sites', () => {
  it('should route every getMailboxLock call in src through lockMailbox', async () => {
    const files = await sourceFiles(srcRoot);
    const offenders: string[] = [];
    await Promise.all(
      files.map(async (file) => {
        const rel = relative(srcRoot, file).split('\\').join('/');
        if (DIRECT_LOCK_CALLERS.has(rel)) return;
        const text = await readFile(file, 'utf-8');
        if (text.includes('.getMailboxLock(')) offenders.push(rel);
      }),
    );

    expect(offenders.sort()).toEqual([]);
  });
});
