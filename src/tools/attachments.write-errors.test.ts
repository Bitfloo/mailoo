import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { withCwdTempDir, withPinnedRoots } from '../test-support/attachment-harness.js';
import { attachmentOpenFailure, writeAttachmentFile } from './attachments.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

function errnoOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

async function directoryNearPathLimit(root: string): Promise<string> {
  const part = 'p'.repeat(200);
  let dir = root;
  for (let depth = 0; depth < 40; depth += 1) {
    const next = path.join(dir, part);
    try {
      // Each component has to exist before the next one can be created.
      // eslint-disable-next-line no-await-in-loop
      await fs.mkdir(next);
      dir = next;
    } catch (err) {
      if (errnoOf(err) === 'ENAMETOOLONG') return dir;
      throw err;
    }
  }
  throw new Error('path limit was not reached');
}

describe('writeAttachmentFile', () => {
  // root bypasses directory permission bits
  it.skipIf(process.getuid?.() === 0)(
    'should report EACCES when the destination directory is not writable',
    async () => {
      await withCwdTempDir(async (dir) => {
        const locked = path.join(dir, 'locked');
        await fs.mkdir(locked);
        await fs.chmod(locked, 0o555);
        try {
          await expect(
            writeAttachmentFile(path.join(locked, 'a.txt'), 'a.txt', Buffer.from('x')),
          ).rejects.toThrow('Could not write savePath (EACCES)');
          await expect(fs.access(path.join(locked, 'a.txt'))).rejects.toThrow();
        } finally {
          await fs.chmod(locked, 0o700);
        }
      });
    },
  );

  // root bypasses directory permission bits
  it.skipIf(process.getuid?.() === 0)(
    'should report EACCES when savePath is locked/sub/a.txt under a mode 0555 directory',
    async () => {
      await withCwdTempDir(async (dir) => {
        const locked = path.join(dir, 'locked');
        await fs.mkdir(locked);
        await fs.chmod(locked, 0o555);
        try {
          const cwd = process.cwd();
          const realCwd = await fs.realpath(cwd);
          let message = '';
          try {
            await writeAttachmentFile('locked/sub/a.txt', 'a.txt', Buffer.from('x'));
          } catch (err) {
            message = err instanceof Error ? err.message : String(err);
          }
          expect(message).toBe('Could not write savePath (EACCES)');
          expect(message).not.toContain(cwd);
          expect(message).not.toContain(realCwd);
        } finally {
          await fs.chmod(locked, 0o700);
        }
      });
    },
  );

  // lstat puts the absolute working directory in the Node error for a segment past NAME_MAX.
  it('should report ENAMETOOLONG when savePath is one 300-byte segment', async () => {
    await withCwdTempDir(async () => {
      const cwd = process.cwd();
      const realCwd = await fs.realpath(cwd);
      let message = '';
      try {
        await writeAttachmentFile('a'.repeat(300), 'a.txt', Buffer.from('x'));
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toBe('Could not write savePath (ENAMETOOLONG)');
      expect(message).not.toContain(cwd);
      expect(message).not.toContain(realCwd);
    });
  });

  // The directory exists, so the failure is open() once the final component crosses PATH_MAX.
  it('should report ENAMETOOLONG when the saved path exceeds the path limit', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-long-'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
    try {
      const dir = await directoryNearPathLimit(base);
      await withPinnedRoots(dir, home, async () => {
        await expect(writeAttachmentFile(dir, 'f'.repeat(200), Buffer.from('x'))).rejects.toThrow(
          'Could not write savePath (ENAMETOOLONG)',
        );
      });
    } finally {
      await fs.rm(base, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('should report ENOSPC when the disk is full', async () => {
    await withCwdTempDir(async (dir) => {
      const open = vi
        .spyOn(fs, 'open')
        .mockRejectedValueOnce(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
      try {
        await expect(
          writeAttachmentFile(path.join(dir, 'a.txt'), 'a.txt', Buffer.from('x')),
        ).rejects.toThrow('Could not write savePath (ENOSPC)');
      } finally {
        open.mockRestore();
      }
    });
  });

  // O_CREAT|O_EXCL reports an existing symlink as EEXIST. O_RDONLY|O_NOFOLLOW is the open that returns ELOOP.
  it('should describe an O_NOFOLLOW ELOOP as a symlink', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-eloop-'));
    try {
      const target = path.join(dir, 'target.txt');
      await fs.writeFile(target, 'original');
      const link = path.join(dir, 'link.txt');
      await fs.symlink(target, link);
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      let caught: unknown;
      try {
        // Open flags are a bitmask.
        // eslint-disable-next-line no-bitwise
        await fs.open(link, fsConstants.O_RDONLY | noFollow);
      } catch (err) {
        caught = err;
      }
      expect(errnoOf(caught)).toBe('ELOOP');
      expect(attachmentOpenFailure(caught).message).toBe('savePath must not be a symlink');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
