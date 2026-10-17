import type { PathLike } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acquireClaim } from './file-claim.js';

describe('acquireClaim', () => {
  let root: string;
  let lockPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-claim-'));
    lockPath = path.join(root, 'entry.lock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  // Without the second create, a free lock waits one more check cycle for nothing.
  it('should take a lock its holder released between the failed create and the age check', async () => {
    await fs.writeFile(lockPath, 'holder', { flag: 'wx' });
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementationOnce(async (file, options) => {
      await fs.unlink(lockPath);
      return stat(file, options as { bigint?: false });
    });
    const token = await acquireClaim(lockPath, 60_000);
    expect(await fs.readFile(lockPath, 'utf8').catch(() => 'gone')).toBe(token ?? 'no token');
  });

  async function writeStaleLock(): Promise<void> {
    await fs.writeFile(lockPath, 'dead holder', { flag: 'wx' });
    const abandonedAt = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, abandonedAt, abandonedAt);
  }

  /**
   * Holds the first rename of the lock until a second caller also found it
   * stale, then runs both renames in that order before either caller resumes.
   */
  function parkBothBeforeEitherResumes(): void {
    const rename = fs.rename.bind(fs);
    type Done = (outcome: Error | undefined) => void;
    let first: { from: PathLike; to: PathLike; done: Done } | undefined;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (first === undefined) {
        const outcome = await new Promise<Error | undefined>((resolve) => {
          first = { from, to, done: resolve };
        });
        if (outcome !== undefined) throw outcome;
        return;
      }
      const failure = (err: Error) => err;
      const firstOutcome = await rename(first.from, first.to).then(() => undefined, failure);
      const ownOutcome = await rename(from, to).then(() => undefined, failure);
      first.done(firstOutcome);
      if (ownOutcome !== undefined) throw ownOutcome;
    });
  }

  // Two scheduler checks that both see a dead holder's lock must not both send the email.
  it('should give a stale lock to exactly one of two concurrent callers', async () => {
    await writeStaleLock();
    parkBothBeforeEitherResumes();
    const tokens = await Promise.all([
      acquireClaim(lockPath, 60_000),
      acquireClaim(lockPath, 60_000),
    ]);
    const winners = tokens.filter((token) => token !== undefined);
    expect({ winners: winners.length, lock: await fs.readFile(lockPath, 'utf8') }).toEqual({
      winners: 1,
      lock: winners[0],
    });
  });

  it('should not take a lock another process created right after the stale one was parked', async () => {
    await writeStaleLock();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      await rename(from, to);
      await fs.writeFile(lockPath, 'other process', { flag: 'wx' });
    });
    const token = await acquireClaim(lockPath, 60_000);
    expect({ token, lock: await fs.readFile(lockPath, 'utf8') }).toEqual({
      token: undefined,
      lock: 'other process',
    });
  });

  // Each steal parks the old lock under a new name, so a parked copy left behind would pile up.
  it('should leave no parked copy behind after taking a stale lock', async () => {
    await writeStaleLock();
    await acquireClaim(lockPath, 60_000);
    expect(await fs.readdir(root)).toEqual(['entry.lock']);
  });
});
