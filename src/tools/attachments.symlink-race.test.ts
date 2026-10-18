import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { withCwdTempDir } from '../test-support/attachment-harness.js';
import { writeAttachmentFile } from './attachments.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

describe('writeAttachmentFile', () => {
  it('does not follow a symlink to a file outside the working directory', async () => {
    const outside = path.join(os.tmpdir(), `mailoo-att-outside-${process.pid}-${Date.now()}.txt`);
    await fs.writeFile(outside, 'original');
    try {
      await withCwdTempDir(async (dir) => {
        const link = path.join(dir, 'link.txt');
        await fs.symlink(outside, link);
        await expect(writeAttachmentFile(link, 'link.txt', Buffer.from('pwned'))).rejects.toThrow(
          /working directory/,
        );
        expect(await fs.readFile(outside, 'utf8')).toBe('original');
      });
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it('does not follow a symlink directory outside the working directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-att-outdir-'));
    try {
      await withCwdTempDir(async (dir) => {
        const link = path.join(dir, 'out');
        await fs.symlink(outside, link);
        await expect(writeAttachmentFile(link, 'evil.txt', Buffer.from('pwned'))).rejects.toThrow(
          /working directory/,
        );
        expect(await fs.readdir(outside)).toEqual([]);
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('does not create a file through a symlinked parent directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-att-parent-'));
    try {
      await withCwdTempDir(async (dir) => {
        const link = path.join(dir, 'linked');
        await fs.symlink(outside, link);
        const dest = path.join(link, 'a.txt');
        await expect(writeAttachmentFile(dest, 'a.txt', Buffer.from('pwned'))).rejects.toThrow(
          /working directory/,
        );
        expect(await fs.readdir(outside)).toEqual([]);
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('should refuse savePath when a raced mkdir leaves a symlink outside the working directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-att-race-'));
    try {
      await withCwdTempDir(async () => {
        const mkdir = vi.spyOn(fs, 'mkdir').mockImplementationOnce(async (target) => {
          await fs.symlink(outside, target);
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        });
        try {
          // A later mkdir would follow this symlink out of the working directory.
          await expect(
            writeAttachmentFile(path.join('new', 'sub', 'a.txt'), 'a.txt', Buffer.from('pwned')),
          ).rejects.toThrow('savePath must stay under the working directory');
          expect(await fs.readdir(outside)).toEqual([]);
        } finally {
          mkdir.mockRestore();
        }
      });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('should refuse savePath when a file appears between the checks and the open', async () => {
    await withCwdTempDir(async (dir) => {
      const dest = path.join(dir, 'a.txt');
      const originalOpen = fs.open;
      const open = vi.spyOn(fs, 'open').mockImplementationOnce(async (target, flags, mode) => {
        await fs.writeFile(target, 'kept');
        return originalOpen(target, flags, mode);
      });
      try {
        // lstat already passed; O_EXCL is what refuses a file created before open.
        await expect(writeAttachmentFile(dest, 'a.txt', Buffer.from('pwned'))).rejects.toThrow(
          'savePath already exists',
        );
        expect(await fs.readFile(dest, 'utf8')).toBe('kept');
      } finally {
        open.mockRestore();
      }
    });
  });
});
