import type { FileHandle } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import withFullDisk from '../test-support/full-disk.js';
import writeFileAtomic, { PRIVATE_FILE_MODE } from './atomic-write.js';

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
    // Under umask 077 a 0644 create also lands at 0600, so the umask is pinned to the common 022.
    const previous = process.umask(0o022);
    try {
      await withDir(async (dir) => {
        const file = path.join(dir, 'state.json');
        await writeFileAtomic(file, '{}');
        const stat = await fs.stat(file);
        expect(stat.mode % 0o1000).toBe(0o600);
      });
    } finally {
      process.umask(previous);
    }
  });

  it('should flush the temp file to disk before renaming it over the target', async () => {
    await withDir(async (dir) => {
      const file = path.join(dir, 'state.json');
      const order: string[] = [];
      const probe = await fs.open(os.devNull, 'r');
      const proto = Object.getPrototypeOf(probe) as FileHandle;
      await probe.close();
      const flushToDisk = proto.sync;
      const syncSpy = vi.spyOn(proto, 'sync').mockImplementation(async function flush(
        this: FileHandle,
      ) {
        order.push('sync');
        return flushToDisk.call(this);
      });
      const rename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        order.push(`rename ${path.basename(String(from))} -> ${path.basename(String(to))}`);
        return rename(from, to);
      });
      try {
        await writeFileAtomic(file, '{}');
      } finally {
        syncSpy.mockRestore();
        renameSpy.mockRestore();
      }
      // Without the flush, a crash after the rename can leave an empty file under the real name.
      expect(order).toEqual([
        'sync',
        expect.stringMatching(/^rename \.state\.json\.[0-9a-f-]+\.tmp -> state\.json$/),
      ]);
    });
  });
});

// The README Files rows name the caller, not this module, so their mode is checked here.
describe('file mode in README.md', () => {
  it('should state the mode atomic writes give queue records and calendar state', async () => {
    const readme = await fs.readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const callers = ['`src/services/scheduler.service.ts` |', '`src/utils/calendar-state.ts` |'];
    const modes = readme
      .split('\n')
      .filter((line) => line.startsWith('|') && callers.some((caller) => line.endsWith(caller)))
      .map((line) => /\(mode `(\d+)`\)/.exec(line)?.[1]);
    const mode = `0${PRIVATE_FILE_MODE.toString(8)}`;
    expect(modes).toEqual([mode, mode]);
  });
});
