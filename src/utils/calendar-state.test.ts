import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import withFullDisk from '../test-support/full-disk.js';

const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-calendar-state-'));
vi.stubEnv('XDG_STATE_HOME', stateHome);

const { CALENDAR_STATE_FILE } = await import('../config/xdg.js');
const {
  CALENDAR_LOCK_FILE: lockPath,
  CALENDAR_LOCK_STALE_MS,
  isCalendarProcessed,
  markCalendarProcessed,
} = await import('./calendar-state.js');

const stateDir = path.dirname(CALENDAR_STATE_FILE);

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(stateHome, { recursive: true, force: true });
});

describe('calendar state file', () => {
  it('should keep earlier entries when the disk fills while saving a new one', async () => {
    await markCalendarProcessed('personal', '1', 'event');
    await withFullDisk(
      (data) => data.includes('processedEmails'),
      async () => {
        await markCalendarProcessed('personal', '2', 'event').catch(() => undefined);
      },
    );
    expect(await isCalendarProcessed('personal', '1')).toBe(true);
  });

  it('should report a damaged state file instead of reading it as empty', async () => {
    // A truncated write leaves this shape. Reading it as empty re-adds every calendar event.
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(CALENDAR_STATE_FILE, '{\n  "processedEmails": {\n    "personal__1"');
    await expect(isCalendarProcessed('personal', '1')).rejects.toThrow(/calendar-processed\.json/);
  });

  it('should read a missing state file as no processed emails', async () => {
    expect(await isCalendarProcessed('personal', '1')).toBe(false);
  });
});

/**
 * Holds the first read of the state file until the other writer has read it
 * too (no lock) or found the lock taken, so two read-modify-writes overlap.
 */
async function withOverlappingWriters(body: () => Promise<void>): Promise<void> {
  let reads = 0;
  let releaseFirst: () => void = () => {};
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const read = fs.readFile.bind(fs);
  const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
    const content = await read(file, options as { encoding: 'utf8' });
    if (file === CALENDAR_STATE_FILE) {
      reads += 1;
      if (reads === 1) await firstMayFinish;
      else releaseFirst();
    }
    return content;
  });
  const stat = fs.stat.bind(fs);
  const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (file, options) => {
    // A writer that finds the lock taken stats it before it waits.
    if (file === lockPath) releaseFirst();
    return stat(file, options as { bigint?: false });
  });
  try {
    await body();
  } finally {
    readSpy.mockRestore();
    statSpy.mockRestore();
  }
}

describe('calendar state lock', () => {
  it('should keep both entries when two processes mark emails at the same time', async () => {
    await markCalendarProcessed('personal', '0', 'event');
    await withOverlappingWriters(async () => {
      await Promise.all([
        markCalendarProcessed('personal', '1', 'event'),
        markCalendarProcessed('personal', '2', 'reminder'),
      ]);
    });
    expect([
      await isCalendarProcessed('personal', '1'),
      await isCalendarProcessed('personal', '2'),
    ]).toEqual([true, true]);
  });

  it('should refuse to mark an email while a live lock stays busy', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(lockPath, 'held', { flag: 'wx' });
    const error = await markCalendarProcessed('personal', '1', 'event').then(
      () => undefined,
      (err: unknown) => String(err),
    );
    expect({
      error,
      stored: await isCalendarProcessed('personal', '1'),
      lock: await fs.readFile(lockPath, 'utf8'),
    }).toEqual({ error: expect.stringMatching(/busy/), stored: false, lock: 'held' });
  });

  it('should free the lock once an email is marked', async () => {
    await markCalendarProcessed('personal', '1', 'event');
    const lockAfterFirst = await fs.access(lockPath).then(
      () => 'present',
      () => 'gone',
    );
    await markCalendarProcessed('personal', '2', 'event');
    expect({
      lockAfterFirst,
      stored: [
        await isCalendarProcessed('personal', '1'),
        await isCalendarProcessed('personal', '2'),
      ],
    }).toEqual({ lockAfterFirst: 'gone', stored: [true, true] });
  });

  it('should take a lock older than the stale window', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(lockPath, 'abandoned', { flag: 'wx' });
    const abandonedAt = new Date(Date.now() - CALENDAR_LOCK_STALE_MS - 60_000);
    await fs.utimes(lockPath, abandonedAt, abandonedAt);
    await markCalendarProcessed('personal', '1', 'event');
    expect({
      stored: await isCalendarProcessed('personal', '1'),
      lock: await fs.readFile(lockPath, 'utf8').catch(() => 'gone'),
    }).toEqual({ stored: true, lock: 'gone' });
  });
});

// Literals, not CALENDAR_LOCK_STALE_MS: a dead holder may block calendar writes for ten seconds.
describe('calendar state lock window', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Whether marking an email succeeds while another holder's lock is ageMs old. */
  async function marksPastLockAged(ageMs: number): Promise<boolean> {
    // Only Date is fake, so the lock's age stays exact while the retries wait in real time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(lockPath, 'held', { flag: 'wx' });
    const lockedAt = new Date(Date.now() - ageMs);
    await fs.utimes(lockPath, lockedAt, lockedAt);
    return markCalendarProcessed('personal', '1', 'event').then(
      () => true,
      () => false,
    );
  }

  it('should take a lock 11 s old', async () => {
    expect(await marksPastLockAged(11_000)).toBe(true);
  });

  it('should refuse a lock 9 s old as busy', async () => {
    expect(await marksPastLockAged(9_000)).toBe(false);
  });

  it('should renew the lock within 2 s while a write still holds it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    let markHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const read = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
      if (file === CALENDAR_STATE_FILE) {
        markHeld();
        await finished;
      }
      return read(file, options as { encoding: 'utf8' });
    });
    const mtime = async () => (await fs.stat(lockPath)).mtimeMs;
    try {
      const marking = markCalendarProcessed('personal', '1', 'event');
      await held;
      const before = await mtime();
      await vi.advanceTimersByTimeAsync(2_000);
      // The renewal is not awaited by its timer, so poll on the real clock until it lands.
      const deadline = performance.now() + 1_000;
      let after = await mtime();
      while (after === before && performance.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
        after = await mtime(); // eslint-disable-line no-await-in-loop
      }
      finish();
      await marking;
      expect(after).toBeGreaterThan(before);
    } finally {
      finish();
      spy.mockRestore();
    }
  });
});
