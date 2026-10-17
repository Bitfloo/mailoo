import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import withFullDisk from '../test-support/full-disk.js';

const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-calendar-state-'));
vi.stubEnv('XDG_STATE_HOME', stateHome);

const { CALENDAR_STATE_FILE } = await import('../config/xdg.js');
const { CALENDAR_LOCK_STALE_MS, isCalendarProcessed, markCalendarProcessed } = await import(
  './calendar-state.js'
);

const stateDir = path.dirname(CALENDAR_STATE_FILE);
const lockPath = `${CALENDAR_STATE_FILE}.lock`;

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

describe('calendar state lock', () => {
  it('should leave a live lock in place when it stays busy', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(lockPath, 'held', { flag: 'wx' });
    await markCalendarProcessed('personal', '1', 'event').catch(() => undefined);
    expect(await fs.readFile(lockPath, 'utf8')).toBe('held');
  });

  it('should take a lock older than the stale window', async () => {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(lockPath, 'abandoned', { flag: 'wx' });
    const abandonedAt = new Date(Date.now() - CALENDAR_LOCK_STALE_MS - 60_000);
    await fs.utimes(lockPath, abandonedAt, abandonedAt);
    await markCalendarProcessed('personal', '1', 'event');
    expect(await isCalendarProcessed('personal', '1')).toBe(true);
  });
});
