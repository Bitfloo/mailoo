import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type ImapService from '../services/imap.service.js';
import registerAttachmentTools, {
  assertPathInsideRoot,
  attachmentOpenFailure,
  SAVE_PATH_MAX_BYTES,
  writeAttachmentFile,
} from './attachments.tool.js';
import registerEmailsTools from './emails.tool.js';

type DownloadHandler = (args: {
  account: string;
  id: string;
  mailbox: string;
  filename: string;
  savePath?: string;
}) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;

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

function captureDownload(imap: unknown, readOnly: boolean): DownloadHandler {
  let handler: DownloadHandler | undefined;
  const server = {
    registerTool: (...args: unknown[]) => {
      handler = args[2] as DownloadHandler;
    },
  };
  registerAttachmentTools(server as never, imap as ImapService, readOnly);
  if (!handler) throw new Error('download_attachment handler was not registered');
  return handler;
}

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

  it('should save an attachment named .env into a directory as env', async () => {
    await withCwdTempDir(async (dir) => {
      const saved = await writeAttachmentFile(dir, '.env', Buffer.from('secret'));
      expect(saved).toBe(path.join(dir, 'env'));
      expect(await fs.readFile(saved, 'utf8')).toBe('secret');
      await expect(fs.access(path.join(dir, '.env'))).rejects.toThrow();
    });
  });

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
    registerAttachmentTools(server as never, { downloadAttachment: vi.fn() } as never, false);
    expect(hints?.readOnlyHint).toBe(false);
  });

  it('should declare download_attachment read-only when read_only is true', () => {
    let hints: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
    const server = {
      registerTool: (
        _name: string,
        config: { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } },
      ) => {
        hints = config.annotations;
      },
    };
    registerAttachmentTools(server as never, { downloadAttachment: vi.fn() } as never, true);
    expect(hints?.readOnlyHint).toBe(true);
    expect(hints?.destructiveHint).toBe(false);
  });

  it('should reject savePath in read_only mode without writing a file', async () => {
    type Handler = (args: {
      account: string;
      id: string;
      mailbox: string;
      filename: string;
      savePath?: string;
    }) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;

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
    registerAttachmentTools(server as never, imap as unknown as ImapService, true);
    if (!handler) throw new Error('download_attachment handler was not registered');
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
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('savePath is not allowed in read_only mode');
      await expect(fs.access(dest)).rejects.toThrow();
      expect(imap.downloadAttachment).not.toHaveBeenCalled();
    });
  });

  it('should return base64 in read_only mode when savePath is omitted', async () => {
    type Handler = (args: {
      account: string;
      id: string;
      mailbox: string;
      filename: string;
    }) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;

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
    registerAttachmentTools(server as never, imap as unknown as ImapService, true);
    if (!handler) throw new Error('download_attachment handler was not registered');

    const result = await handler({
      account: 'test',
      id: '1',
      mailbox: 'INBOX',
      filename: 'a.txt',
    });
    const combined = result.content.map((part) => part.text).join('\n');
    expect(result.isError).toBeUndefined();
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

    registerAttachmentTools(server as never, imap as unknown as ImapService, false);
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

    registerAttachmentTools(server as never, imap as unknown as ImapService, false);
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

  it('should decode the base64 line to the same bytes that were downloaded', async () => {
    // 51 bytes: wrapping this payload in letter-and-underscore markers decodes to 93 bytes.
    const pdf = Buffer.alloc(51);
    pdf.write('%PDF');
    const run = captureDownload(
      {
        downloadAttachment: vi.fn().mockResolvedValue({
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          size: pdf.length,
          contentBase64: pdf.toString('base64'),
        }),
      },
      false,
    );
    const result = await run({
      account: 'test',
      id: '1',
      mailbox: 'INBOX',
      filename: 'report.pdf',
    });
    const part = result.content.find((entry) => entry.text.includes('--- Base64 Content ---'));
    const marker = '--- Base64 Content ---\n';
    const encoded = part?.text.slice((part?.text.indexOf(marker) ?? -1) + marker.length).trim();
    expect(Buffer.from(encoded ?? '', 'base64')).toEqual(pdf);
  });

  it('should return the same attachment filename get_email shows', async () => {
    const filename = 'report.pdf';
    const email = {
      id: '1',
      subject: 'Quarterly report',
      from: { name: 'Ada', address: 'ada@example.com' },
      to: [{ address: 'me@example.com' }],
      date: '2026-01-02T00:00:00.000Z',
      messageId: '<m@example.com>',
      seen: true,
      flagged: false,
      answered: false,
      labels: [],
      hasAttachments: true,
      attachments: [{ filename, mimeType: 'application/pdf', size: 51 }],
      headers: {},
      bodyText: 'See attached.',
    };
    let getEmail:
      | ((args: { account: string; emailId: string }) => Promise<{
          content: { text: string }[];
        }>)
      | undefined;
    const emailServer = {
      registerTool: (name: string, _config: unknown, fn: NonNullable<typeof getEmail>) => {
        if (name === 'get_email') getEmail = fn;
      },
    };
    registerEmailsTools(
      emailServer as never,
      { getEmail: vi.fn().mockResolvedValue(email) } as never,
      false,
    );
    if (!getEmail) throw new Error('get_email handler was not registered');
    const shown = await getEmail({ account: 'test', emailId: '1' });
    const listed = /📎 Attachments: (.+) \(application\/pdf, /.exec(shown.content[0]?.text ?? '');

    const run = captureDownload(
      {
        downloadAttachment: vi.fn().mockResolvedValue({
          filename,
          mimeType: 'application/pdf',
          size: 51,
          contentBase64: Buffer.from('%PDF').toString('base64'),
        }),
      },
      false,
    );
    const result = await run({
      account: 'test',
      id: '1',
      mailbox: 'INBOX',
      filename,
    });
    const payload = JSON.parse(result.content[0]?.text ?? '') as { filename?: string };
    expect(payload.filename).toBe(listed?.[1]);
  });

  it('should keep the savePath metadata filename equal to the downloaded name', async () => {
    const filename = 'report.pdf';
    const run = captureDownload(
      {
        downloadAttachment: vi.fn().mockResolvedValue({
          filename,
          mimeType: 'application/pdf',
          size: 5,
          contentBase64: Buffer.from('%PDF').toString('base64'),
        }),
      },
      false,
    );
    await withCwdTempDir(async (dir) => {
      const result = await run({
        account: 'test',
        id: '1',
        mailbox: 'INBOX',
        filename,
        savePath: path.join(dir, filename),
      });
      const payload = JSON.parse(result.content[0]?.text ?? '') as { filename?: string };
      expect(payload.filename).toBe(filename);
    });
  });
});
