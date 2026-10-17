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
});
