import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type ImapService from '../services/imap.service.js';
import registerAttachmentTools, {
  assertPathInsideRoot,
  SAVE_PATH_MAX_BYTES,
  writeAttachmentFile,
} from './attachments.tool.js';

async function withPinnedRoots<T>(cwd: string, home: string, fn: () => Promise<T>): Promise<T> {
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    return await fn();
  } finally {
    cwdSpy.mockRestore();
    homeSpy.mockRestore();
  }
}

async function withCwdTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-att-'));
  try {
    return await withPinnedRoots(dir, dir, async () => fn(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withTempCwdAndHome<T>(
  fn: (dirs: { cwd: string; home: string }) => Promise<T>,
): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cwd-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
  try {
    return await withPinnedRoots(cwd, home, async () => fn({ cwd, home }));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
}

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

  it('keeps a dot-dot attachment name inside the destination directory', async () => {
    await withCwdTempDir(async (dir) => {
      const saved = await writeAttachmentFile(dir, '..', Buffer.from('inside'));
      expect(path.dirname(saved)).toBe(dir);
      expect(path.basename(saved)).not.toBe('..');
      expect(await fs.readFile(saved, 'utf8')).toBe('inside');
    });
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

  it('creates a missing directory under the working directory', async () => {
    await withCwdTempDir(async (dir) => {
      const dest = path.join(dir, 'nested', 'a.txt');
      const saved = await writeAttachmentFile(dest, 'a.txt', Buffer.from('nested'));
      expect(saved).toBe(dest);
      expect(await fs.readFile(dest, 'utf8')).toBe('nested');
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
});

describe('download_attachment tool', () => {
  it('sets the savePath size cap at 50 mebibytes', () => {
    expect(SAVE_PATH_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it('sets readOnlyHint to false because savePath can write', () => {
    let hints: { readOnlyHint?: boolean } | undefined;
    const server = {
      registerTool: (_name: string, config: { annotations?: { readOnlyHint?: boolean } }) => {
        hints = config.annotations;
      },
    };
    registerAttachmentTools(server as never, { downloadAttachment: vi.fn() } as never);
    expect(hints?.readOnlyHint).toBe(false);
  });

  it('returns savedTo and no base64 body when savePath is set', async () => {
    type Handler = (args: {
      account: string;
      id: string;
      mailbox: string;
      filename: string;
      savePath?: string;
    }) => Promise<{ content: { type: string; text: string }[] }>;

    let handler: Handler | undefined;
    const server = {
      registerTool: (...args: unknown[]) => {
        handler = args[2] as Handler;
      },
    };
    const imap = {
      downloadAttachment: vi.fn().mockResolvedValue({
        filename: 'a.txt',
        mimeType: 'text/plain',
        size: 5,
        contentBase64: Buffer.from('hello').toString('base64'),
      }),
    };

    registerAttachmentTools(server as never, imap as unknown as ImapService);
    if (!handler) {
      throw new Error('download_attachment handler was not registered');
    }
    const run = handler;

    await withCwdTempDir(async (dir) => {
      const dest = path.join(dir, 'a.txt');
      const result = await run({
        account: 'test',
        id: '1',
        mailbox: 'INBOX',
        filename: 'a.txt',
        savePath: dest,
      });
      const payload = JSON.parse(result.content[0].text) as { savedTo?: string };
      const combined = result.content.map((c) => c.text).join('\n');
      expect(payload.savedTo).toBe(dest);
      expect(combined).not.toMatch(/Base64|aGVsbG8=/);
      expect(imap.downloadAttachment).toHaveBeenCalledWith(
        'test',
        '1',
        'INBOX',
        'a.txt',
        50 * 1024 * 1024,
      );
    });
  });

  it('returns Base64 content and a 5MB cap when savePath is omitted', async () => {
    type Handler = (args: {
      account: string;
      id: string;
      mailbox: string;
      filename: string;
      savePath?: string;
    }) => Promise<{ content: { type: string; text: string }[] }>;

    let handler: Handler | undefined;
    const server = {
      registerTool: (...args: unknown[]) => {
        handler = args[2] as Handler;
      },
    };
    const raw = Buffer.from('hello');
    const imap = {
      downloadAttachment: vi.fn().mockResolvedValue({
        filename: 'a.txt',
        mimeType: 'text/plain',
        size: 5,
        contentBase64: raw.toString('base64'),
      }),
    };

    registerAttachmentTools(server as never, imap as unknown as ImapService);
    if (!handler) {
      throw new Error('download_attachment handler was not registered');
    }

    const result = await handler({
      account: 'test',
      id: '1',
      mailbox: 'INBOX',
      filename: 'a.txt',
    });
    const combined = result.content.map((c) => c.text).join('\n');
    expect(combined).toContain('--- Base64 Content ---');
    expect(combined).toContain(raw.toString('base64'));
    expect(imap.downloadAttachment).toHaveBeenCalledWith(
      'test',
      '1',
      'INBOX',
      'a.txt',
      5 * 1024 * 1024,
    );
  });
});
