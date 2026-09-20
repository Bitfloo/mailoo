import fs from 'node:fs/promises';
import path from 'node:path';

import type ImapService from '../services/imap.service.js';
import registerAttachmentTools, {
  assertPathInsideRoot,
  SAVE_PATH_MAX_BYTES,
  writeAttachmentFile,
} from './attachments.tool.js';

async function withCwdTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-mailoo-att-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
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
});

describe('download_attachment tool', () => {
  it('sets readOnlyHint to false because savePath can write', () => {
    let hints: { readOnlyHint?: boolean } | undefined;
    const server = {
      tool: (
        _name: string,
        _desc: string,
        _schema: unknown,
        annotations: { readOnlyHint?: boolean },
      ) => {
        hints = annotations;
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
      tool: (...args: unknown[]) => {
        handler = args[4] as Handler;
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
        SAVE_PATH_MAX_BYTES,
      );
    });
  });
});
