import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  withCwdTempDir,
  withPinnedRoots,
  withTempCwdAndHome,
} from '../test-support/attachment-harness.js';
import { assertPathInsideRoot, writeAttachmentFile } from './attachments.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

async function filesystemIgnoresCase(): Promise<boolean> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-case-'));
  try {
    await fs.writeFile(path.join(dir, 'CaseProbe'), '');
    try {
      await fs.stat(path.join(dir, 'caseprobe'));
      return true;
    } catch {
      return false;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const caseInsensitiveFilesystem = await filesystemIgnoresCase();

describe('writeAttachmentFile', () => {
  it('writes decoded bytes to savePath and does not return them', async () => {
    await withCwdTempDir(async (dir) => {
      const dest = path.join(dir, 'notes.txt');
      const saved = await writeAttachmentFile(dest, 'notes.txt', Buffer.from('hello-attachment'));
      expect(saved).toBe(dest);
      expect(await fs.readFile(dest, 'utf8')).toBe('hello-attachment');
    });
  });

  it('treats an existing directory as the destination folder', async () => {
    await withCwdTempDir(async (dir) => {
      const saved = await writeAttachmentFile(dir, 'file.bin', Buffer.from([1, 2, 3]));
      expect(saved).toBe(path.join(dir, 'file.bin'));
      expect(await fs.readFile(saved)).toEqual(Buffer.from([1, 2, 3]));
    });
  });

  it('rejects a path that escapes the working directory', async () => {
    const outside = path.resolve(process.cwd(), '..', 'mailoo-escape-probe.txt');
    expect(() => assertPathInsideRoot(outside, path.resolve(process.cwd()))).toThrow(
      /working directory/,
    );
    await expect(writeAttachmentFile(outside, 'x.txt', Buffer.from('nope'))).rejects.toThrow(
      /working directory/,
    );
  });

  it('should refuse a savePath whose file name starts with a dot', async () => {
    await withTempCwdAndHome(async ({ cwd }) => {
      await expect(
        writeAttachmentFile('.secret.txt', 'notes.txt', Buffer.from('pwned')),
      ).rejects.toThrow(/not allowed/);
      await expect(fs.access(path.join(cwd, '.secret.txt'))).rejects.toThrow();
    });
  });

  it('should refuse a hidden directory segment in savePath', async () => {
    await withTempCwdAndHome(async ({ cwd }) => {
      await expect(
        writeAttachmentFile(path.join('.x', 'file'), 'file', Buffer.from('pwned')),
      ).rejects.toThrow(/not allowed/);
      await expect(fs.access(path.join(cwd, '.x'))).rejects.toThrow();
    });
  });

  it('should refuse savePath under Library/LaunchAgents in the home directory', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
    try {
      await withPinnedRoots(home, home, async () => {
        await expect(
          writeAttachmentFile(
            path.join('Library', 'LaunchAgents', 'x.plist'),
            'x.plist',
            Buffer.from('pwned'),
          ),
        ).rejects.toThrow(/not allowed/);
      });
      await expect(fs.access(path.join(home, 'Library'))).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  // Linux filesystems are case-sensitive; the macOS pre-push unit lane runs this.
  it.runIf(caseInsensitiveFilesystem)(
    'should refuse savePath library/LaunchAgents when the directory on disk is Library',
    async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
      const agents = path.join(home, 'Library', 'LaunchAgents');
      await fs.mkdir(agents, { recursive: true });
      try {
        await withPinnedRoots(home, home, async () => {
          await expect(
            writeAttachmentFile(
              path.join('library', 'LaunchAgents', 'x.plist'),
              'x.plist',
              Buffer.from('pwned'),
            ),
          ).rejects.toThrow(/not allowed/);
        });
        expect(await fs.readdir(agents)).toEqual([]);
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it('should refuse a savePath whose resolved path is under Library/LaunchAgents', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
    const agents = path.join(home, 'Library', 'LaunchAgents');
    await fs.mkdir(agents, { recursive: true });
    await fs.symlink(agents, path.join(home, 'Documents'));
    try {
      await withPinnedRoots(home, home, async () => {
        await expect(
          writeAttachmentFile(path.join('Documents', 'x.plist'), 'x.plist', Buffer.from('pwned')),
        ).rejects.toThrow(/not allowed/);
      });
      expect(await fs.readdir(agents)).toEqual([]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  // "/" is the POSIX filesystem root. A Windows drive root is a different path shape.
  it.skipIf(process.platform === 'win32')(
    'should refuse savePath when the working directory is /',
    async () => {
      const target = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-root-target-'));
      // macOS /tmp and /var are symlinks, which the segment walk already refuses.
      // The resolved directory is a real path under /, so confinement to / would create it.
      const realTarget = await fs.realpath(target);
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
      const dest = path.join(realTarget, 'nested', 'probe.txt');
      try {
        await withPinnedRoots('/', home, async () => {
          await expect(
            writeAttachmentFile(dest, 'probe.txt', Buffer.from('pwned')),
          ).rejects.toThrow(/not allowed/);
        });
        await expect(fs.access(dest)).rejects.toThrow();
        await expect(fs.access(path.dirname(dest))).rejects.toThrow();
      } finally {
        await fs.rm(target, { recursive: true, force: true });
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it('should write a file in a subdirectory of a specific working directory', async () => {
    await withTempCwdAndHome(async ({ cwd }) => {
      const saved = await writeAttachmentFile(
        path.join('nested', 'a.txt'),
        'a.txt',
        Buffer.from('ok'),
      );
      expect(saved).toBe(path.join(cwd, 'nested', 'a.txt'));
      expect(await fs.readFile(saved, 'utf8')).toBe('ok');
    });
  });

  it('should refuse a savePath whose file name starts with two dots', async () => {
    await withCwdTempDir(async (dir) => {
      const dest = path.join(dir, '..notes.txt');
      await expect(writeAttachmentFile(dest, '..notes.txt', Buffer.from('dots'))).rejects.toThrow(
        /not allowed/,
      );
      await expect(fs.access(dest)).rejects.toThrow();
    });
  });

  it('does not replace an existing file', async () => {
    await withCwdTempDir(async (dir) => {
      const dest = path.join(dir, 'notes.txt');
      await fs.writeFile(dest, 'original');
      await expect(writeAttachmentFile(dest, 'notes.txt', Buffer.from('replaced'))).rejects.toThrow(
        /exist/,
      );
      expect(await fs.readFile(dest, 'utf8')).toBe('original');
    });
  });

  it('keeps a dot-dot attachment name inside the destination directory', async () => {
    await withCwdTempDir(async (dir) => {
      const saved = await writeAttachmentFile(dir, '..', Buffer.from('inside'));
      expect(path.dirname(saved)).toBe(dir);
      expect(path.basename(saved)).not.toBe('..');
      expect(await fs.readFile(saved, 'utf8')).toBe('inside');
    });
  });

  it('creates a missing directory under the working directory', async () => {
    await withCwdTempDir(async (dir) => {
      const dest = path.join(dir, 'nested', 'a.txt');
      const saved = await writeAttachmentFile(dest, 'a.txt', Buffer.from('nested'));
      expect(saved).toBe(dest);
      expect(await fs.readFile(dest, 'utf8')).toBe('nested');
    });
  });

  it('should write both files when two saves create the same new directory', async () => {
    await withCwdTempDir(async () => {
      const [savedA, savedB] = await Promise.all([
        writeAttachmentFile(path.join('new', 'a.txt'), 'a.txt', Buffer.from('file-a')),
        writeAttachmentFile(path.join('new', 'b.txt'), 'b.txt', Buffer.from('file-b')),
      ]);
      expect(await fs.readFile(savedA, 'utf8')).toBe('file-a');
      expect(await fs.readFile(savedB, 'utf8')).toBe('file-b');
    });
  });

  it('strips control characters from an attachment filename', async () => {
    await withCwdTempDir(async (dir) => {
      const saved = await writeAttachmentFile(dir, 'a\nb.txt', Buffer.from('line'));
      expect(path.dirname(saved)).toBe(dir);
      expect(path.basename(saved)).not.toMatch(/[\r\n]/);
      expect(await fs.readFile(saved, 'utf8')).toBe('line');
    });
  });

  it('should save an attachment named .env into a directory as env', async () => {
    await withCwdTempDir(async (dir) => {
      const saved = await writeAttachmentFile(dir, '.env', Buffer.from('secret'));
      expect(saved).toBe(path.join(dir, 'env'));
      expect(await fs.readFile(saved, 'utf8')).toBe('secret');
      await expect(fs.access(path.join(dir, '.env'))).rejects.toThrow();
    });
  });
});
