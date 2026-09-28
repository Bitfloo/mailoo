import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_OUTGOING_ATTACHMENT_BYTES,
  resolveOutgoingAttachments,
} from './outgoing-attachments.js';

async function withRoots<T>(fn: (dirs: { cwd: string; home: string }) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cwd-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
  try {
    return await fn({ cwd, home });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
}

function opts(dirs: { cwd: string; home: string }) {
  return { root: dirs.cwd, homeDir: dirs.home };
}

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

describe('resolveOutgoingAttachments', () => {
  it('should read a regular file inside the working directory', async () => {
    await withRoots(async (dirs) => {
      const file = path.join(dirs.cwd, 'note.txt');
      await fs.writeFile(file, 'hello-file');
      const parts = await resolveOutgoingAttachments([{ path: file }], opts(dirs));
      expect(parts).toEqual([{ filename: 'note.txt', content: Buffer.from('hello-file') }]);
    });
  });

  it('should read a file under the home directory outside the working directory', async () => {
    await withRoots(async (dirs) => {
      const docs = path.join(dirs.home, 'Documents');
      await fs.mkdir(docs);
      const file = path.join(docs, 'a.txt');
      await fs.writeFile(file, 'from-home');
      const parts = await resolveOutgoingAttachments([{ path: file }], opts(dirs));
      expect(parts[0].content.toString()).toBe('from-home');
    });
  });

  it('should expand a ~/ path under the home directory', async () => {
    await withRoots(async (dirs) => {
      const docs = path.join(dirs.home, 'Documents');
      await fs.mkdir(docs);
      await fs.writeFile(path.join(docs, 'a.txt'), 'tilde-home');
      const parts = await resolveOutgoingAttachments([{ path: '~/Documents/a.txt' }], opts(dirs));
      expect(parts[0].content.toString()).toBe('tilde-home');
    });
  });

  it('should reject a ~user path', async () => {
    await withRoots(async (dirs) => {
      await expect(
        resolveOutgoingAttachments([{ path: '~other/secret.txt' }], opts(dirs)),
      ).rejects.toThrow(/local file/);
    });
  });

  it('should reject a ~/.ssh path', async () => {
    await withRoots(async (dirs) => {
      const ssh = path.join(dirs.home, '.ssh');
      await fs.mkdir(ssh);
      await fs.writeFile(path.join(ssh, 'id_rsa'), 'not-a-real-key');
      await expect(
        resolveOutgoingAttachments([{ path: '~/.ssh/id_rsa' }], opts(dirs)),
      ).rejects.toThrow(/not allowed/);
    });
  });

  it('should reject /etc/passwd', async () => {
    await withRoots(async (dirs) => {
      await expect(
        resolveOutgoingAttachments([{ path: '/etc/passwd' }], opts(dirs)),
      ).rejects.toThrow(/not allowed/);
    });
  });

  it('should reject a symlink that points at a hidden file inside the home directory', async () => {
    await withRoots(async (dirs) => {
      const ssh = path.join(dirs.home, '.ssh');
      await fs.mkdir(ssh);
      const key = path.join(ssh, 'id_rsa');
      await fs.writeFile(key, 'not-a-real-key');
      const docs = path.join(dirs.home, 'Documents');
      await fs.mkdir(docs);
      const link = path.join(docs, 'link.txt');
      await fs.symlink(key, link);
      await expect(resolveOutgoingAttachments([{ path: link }], opts(dirs))).rejects.toThrow(
        /not allowed/,
      );
    });
  });

  it('should reject a symlink whose target leaves the allowed directories', async () => {
    await withRoots(async (dirs) => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-secret-'));
      try {
        const secret = path.join(outside, 'secret.txt');
        await fs.writeFile(secret, 'outside-secret-marker');
        const link = path.join(dirs.cwd, 'escape.txt');
        await fs.symlink(secret, link);
        await expect(resolveOutgoingAttachments([{ path: link }], opts(dirs))).rejects.toThrow(
          /not allowed/,
        );
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('should read a symlink whose target stays inside the working directory', async () => {
    await withRoots(async (dirs) => {
      const target = path.join(dirs.cwd, 'target.txt');
      await fs.writeFile(target, 'linked-body');
      const link = path.join(dirs.cwd, 'link.txt');
      await fs.symlink(target, link);
      const parts = await resolveOutgoingAttachments([{ path: link }], opts(dirs));
      expect(parts[0].content.toString()).toBe('linked-body');
      expect(parts[0].filename).toBe('link.txt');
    });
  });

  it('should reject an http URL without fetching it', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('remote-secret');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    try {
      await withRoots(async (dirs) => {
        await expect(
          resolveOutgoingAttachments([{ path: `http://127.0.0.1:${port}/secret` }], opts(dirs)),
        ).rejects.toThrow(/local file/);
      });
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it('should reject a file URL', async () => {
    await withRoots(async (dirs) => {
      const file = path.join(dirs.cwd, 'note.txt');
      await fs.writeFile(file, 'local-bytes');
      await expect(
        resolveOutgoingAttachments([{ path: `file://${file}` }], opts(dirs)),
      ).rejects.toThrow(/local file/);
    });
  });

  it('should reject a data URL', async () => {
    await withRoots(async (dirs) => {
      await expect(
        resolveOutgoingAttachments([{ path: 'data:text/plain,hello' }], opts(dirs)),
      ).rejects.toThrow(/local file/);
    });
  });

  it('should reject a protocol-relative URL', async () => {
    await withRoots(async (dirs) => {
      await expect(
        resolveOutgoingAttachments([{ path: '//example.com/secret.txt' }], opts(dirs)),
      ).rejects.toThrow(/local file/);
    });
  });

  it('should reject a path that contains a null byte', async () => {
    await withRoots(async (dirs) => {
      await expect(
        resolveOutgoingAttachments([{ path: `note${String.fromCharCode(0)}.txt` }], opts(dirs)),
      ).rejects.toThrow(/local file/);
    });
  });

  it('should reject a file when the working directory is /tmp', async () => {
    const dir = await fs.mkdtemp(path.join('/tmp', 'mailoo-broad-'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
    try {
      const file = path.join(dir, 'a.txt');
      await fs.writeFile(file, 'tmp-file');
      await expect(
        resolveOutgoingAttachments([{ path: file }], { root: '/tmp', homeDir: home }),
      ).rejects.toThrow(/not allowed/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  // A symlink to /tmp needs extra privileges on Windows.
  it.skipIf(process.platform === 'win32')(
    'should reject a file when the working directory is a symlink to /tmp',
    async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-root-link-'));
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
      const fileDir = await fs.mkdtemp(path.join('/tmp', 'mailoo-broad-'));
      try {
        const link = path.join(parent, 'cwd');
        await fs.symlink('/tmp', link);
        const file = path.join(fileDir, 'a.txt');
        await fs.writeFile(file, 'tmp-file');
        await expect(
          resolveOutgoingAttachments([{ path: file }], { root: link, homeDir: home }),
        ).rejects.toThrow(/not allowed/);
      } finally {
        await fs.rm(parent, { recursive: true, force: true });
        await fs.rm(home, { recursive: true, force: true });
        await fs.rm(fileDir, { recursive: true, force: true });
      }
    },
  );

  // On Linux realpath('/tmp') is '/tmp', which the direct-child rule already refuses.
  it.skipIf(process.platform !== 'darwin')(
    'should reject a file when the working directory is the real path of /tmp',
    async () => {
      const root = await fs.realpath('/tmp');
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
      const fileDir = await fs.mkdtemp(path.join(root, 'mailoo-broad-'));
      try {
        const file = path.join(fileDir, 'a.txt');
        await fs.writeFile(file, 'tmp-file');
        await expect(
          resolveOutgoingAttachments([{ path: file }], { root, homeDir: home }),
        ).rejects.toThrow(/not allowed/);
      } finally {
        await fs.rm(home, { recursive: true, force: true });
        await fs.rm(fileDir, { recursive: true, force: true });
      }
    },
  );

  it('should read a file when the working directory is a subdirectory of the system temp directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cwd-'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
    try {
      const file = path.join(root, 'a.txt');
      await fs.writeFile(file, 'temp-ok');
      const parts = await resolveOutgoingAttachments([{ path: file }], { root, homeDir: home });
      expect(parts[0].content.toString()).toBe('temp-ok');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('should reject a macOS cookies path under the home directory', async () => {
    await withRoots(async (dirs) => {
      const dir = path.join(dirs.home, 'Library', 'Cookies');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'Cookies.binarycookies');
      await fs.writeFile(file, 'not-real-cookies');
      await expect(resolveOutgoingAttachments([{ path: file }], opts(dirs))).rejects.toThrow(
        /not allowed/,
      );
    });
  });

  it('should reject a directory', async () => {
    await withRoots(async (dirs) => {
      const sub = path.join(dirs.cwd, 'sub');
      await fs.mkdir(sub);
      await expect(resolveOutgoingAttachments([{ path: sub }], opts(dirs))).rejects.toThrow(
        /regular file/,
      );
    });
  });

  // Linux filesystems are case-sensitive; the macOS pre-push unit lane runs this.
  it.runIf(caseInsensitiveFilesystem)(
    'should refuse ~/library/Messages when the directory on disk is Library',
    async () => {
      await withRoots(async (dirs) => {
        const messages = path.join(dirs.home, 'Library', 'Messages');
        await fs.mkdir(messages, { recursive: true });
        await fs.writeFile(path.join(messages, 'chat.txt'), 'not-messages');
        await expect(
          resolveOutgoingAttachments([{ path: '~/library/Messages/chat.txt' }], opts(dirs)),
        ).rejects.toThrow(/not allowed/);
      });
    },
  );

  it('should reject a file under ~/Library', async () => {
    await withRoots(async (dirs) => {
      const dir = path.join(dirs.home, 'Library', 'Application Support', 'Browser');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'Cookies');
      await fs.writeFile(file, 'not-browser-cookies');
      await expect(resolveOutgoingAttachments([{ path: file }], opts(dirs))).rejects.toThrow(
        /not allowed/,
      );
    });
  });

  it('should reject a file under ~/AppData', async () => {
    await withRoots(async (dirs) => {
      const dir = path.join(dirs.home, 'AppData', 'Roaming');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'secret.txt');
      await fs.writeFile(file, 'not-appdata');
      await expect(resolveOutgoingAttachments([{ path: file }], opts(dirs))).rejects.toThrow(
        /not allowed/,
      );
    });
  });

  it('should reject a file under ~/snap', async () => {
    await withRoots(async (dirs) => {
      const dir = path.join(dirs.home, 'snap', 'firefox', 'common');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'session');
      await fs.writeFile(file, 'not-a-session');
      await expect(resolveOutgoingAttachments([{ path: file }], opts(dirs))).rejects.toThrow(
        /not allowed/,
      );
    });
  });

  it('should read a file under ~/Library/Mobile Documents', async () => {
    await withRoots(async (dirs) => {
      const dir = path.join(dirs.home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'note.txt');
      await fs.writeFile(file, 'icloud-doc');
      const parts = await resolveOutgoingAttachments([{ path: file }], opts(dirs));
      expect(parts[0].content.toString()).toBe('icloud-doc');
    });
  });

  it('should read a file under ~/Library/CloudStorage', async () => {
    await withRoots(async (dirs) => {
      const dir = path.join(dirs.home, 'Library', 'CloudStorage', 'Dropbox');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'note.txt');
      await fs.writeFile(file, 'cloud-doc');
      const parts = await resolveOutgoingAttachments([{ path: file }], opts(dirs));
      expect(parts[0].content.toString()).toBe('cloud-doc');
    });
  });

  it('should reject a symlink from ~/Documents into ~/Library/Messages', async () => {
    await withRoots(async (dirs) => {
      const messages = path.join(dirs.home, 'Library', 'Messages');
      await fs.mkdir(messages, { recursive: true });
      const secret = path.join(messages, 'secret.txt');
      await fs.writeFile(secret, 'messages-secret');
      const docs = path.join(dirs.home, 'Documents');
      await fs.mkdir(docs);
      const link = path.join(docs, 'link.txt');
      await fs.symlink(secret, link);
      await expect(resolveOutgoingAttachments([{ path: link }], opts(dirs))).rejects.toThrow(
        /not allowed/,
      );
    });
  });

  it('should reject a macOS keychain path under the home directory', async () => {
    await withRoots(async (dirs) => {
      const dir = path.join(dirs.home, 'Library', 'Keychains');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'login.keychain-db');
      await fs.writeFile(file, 'not-a-real-keychain');
      await expect(resolveOutgoingAttachments([{ path: file }], opts(dirs))).rejects.toThrow(
        /not allowed/,
      );
    });
  });

  it('should reject base64 content over the size limit', async () => {
    const big = Buffer.alloc(32, 1).toString('base64');
    await expect(
      resolveOutgoingAttachments([{ filename: 'a.bin', base64: big }], { maxBytes: 8 }),
    ).rejects.toThrow(/8 byte limit/);
  });

  it('should reject attachments whose combined size exceeds the limit', async () => {
    const chunk = Buffer.from('123456').toString('base64');
    await expect(
      resolveOutgoingAttachments(
        [
          { filename: 'a.txt', base64: chunk },
          { filename: 'b.txt', base64: chunk },
        ],
        { maxBytes: 10 },
      ),
    ).rejects.toThrow(/10 byte limit/);
  });

  it('should reject a file larger than the default limit', async () => {
    await withRoots(async (dirs) => {
      const file = path.join(dirs.cwd, 'big.bin');
      const handle = await fs.open(file, 'w');
      await handle.truncate(MAX_OUTGOING_ATTACHMENT_BYTES + 1);
      await handle.close();
      await expect(resolveOutgoingAttachments([{ path: file }], opts(dirs))).rejects.toThrow(
        String(MAX_OUTGOING_ATTACHMENT_BYTES),
      );
    });
  });

  it('should keep only the base name of an explicit filename', async () => {
    const parts = await resolveOutgoingAttachments([
      {
        filename: '../../note.txt',
        base64: Buffer.from('hi').toString('base64'),
      },
    ]);
    expect(parts[0].filename).toBe('note.txt');
    expect(parts[0].content.toString()).toBe('hi');
  });

  it('should skip a mailbox copy when no downloader is provided', async () => {
    const parts = await resolveOutgoingAttachments([{ emailId: '1', filename: 'a.txt' }]);
    expect(parts).toEqual([]);
  });
});
