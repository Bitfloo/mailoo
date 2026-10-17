import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import withFullDisk from '../test-support/full-disk.js';
import writeFileAtomic from './atomic-write.js';

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-atomic-'));
  try {
    await body(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('writeFileAtomic', () => {
  it('should leave the previous bytes in place when the disk fills part-way', async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, 'state.json');
      await fs.writeFile(file, '{"version":1}');
      await withFullDisk(
        (data) => data.includes('"version":2'),
        async () => {
          await expect(writeFileAtomic(file, '{"version":2}')).rejects.toMatchObject({
            code: 'ENOSPC',
          });
        },
      );
      expect(await fs.readFile(file, 'utf8')).toBe('{"version":1}');
    });
  });

  it('should not leave a temp file behind when the write fails', async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, 'state.json');
      await withFullDisk(
        () => true,
        async () => {
          await writeFileAtomic(file, '{}').catch(() => undefined);
        },
      );
      expect(await fs.readdir(dir)).toEqual([]);
    });
  });

  it('should create the file readable by its owner only', async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, 'state.json');
      await writeFileAtomic(file, '{}');
      const stat = await fs.stat(file);
      expect(stat.mode % 0o1000).toBe(0o600);
    });
  });
});
