import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import withFullDisk from './full-disk.js';

describe('full disk helper', () => {
  it('should fail when no write matched, so a test cannot pass on a disk that never filled', async () => {
    await expect(
      withFullDisk(
        () => false,
        async () => {},
      ),
    ).rejects.toThrow('no write matched the full-disk predicate');
  });

  // A disk that rejects the whole write leaves no torn file, so the code's handling of a
  // half-written record would go untested.
  it.each([
    ['fs.writeFile', async (file: string, data: string) => fs.writeFile(file, data)],
    [
      'FileHandle.writeFile',
      async (file: string, data: string) => {
        const handle = await fs.open(file, 'w');
        try {
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }
      },
    ],
  ])(
    'should keep the first eight bytes and fail with ENOSPC when %s fills the disk',
    async (_name, write) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-full-disk-'));
      try {
        const file = path.join(dir, 'record.json');
        let code: unknown;
        await withFullDisk(
          (data) => data.startsWith('{"id"'),
          async () => {
            await write(file, '{"id":"0123456789"}').catch((err: unknown) => {
              code = (err as { code?: unknown }).code;
            });
          },
        );
        expect({ kept: await fs.readFile(file, 'utf8'), code }).toEqual({
          kept: '{"id":"0',
          code: 'ENOSPC',
        });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
