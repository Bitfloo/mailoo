import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import type { IConnectionManager } from '../connections/types.js';
import ImapService, { emlFilename } from '../services/imap.service.js';
import registerAttachmentTools from './attachments.tool.js';
import registerExportTools, { INLINE_MAX_BYTES } from './export.tool.js';

interface ExportArgs {
  account: string;
  id: string;
  mailbox: string;
  savePath?: string;
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

interface ToolConfig {
  inputSchema: z.ZodRawShape;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** What imapflow's fetchOne returns for one UID. */
interface ServerMessage {
  size?: number;
  internalDate?: Date | string;
  /** Absent when the test claims the source is never transferred. */
  source?: Buffer;
}

const ACCOUNT = 'personal';
const UID = '42';
const MARKER = '--- Base64 Content ---\n';

function serviceFor(message: ServerMessage): ImapService {
  const client = {
    getMailboxLock: async () => ({ release: () => undefined }),
    fetchOne: async (uid: string, query: { source?: unknown }) => {
      if (query.source) {
        if (!message.source) throw new Error('the source was fetched for a message over the cap');
        return { uid: Number(uid), source: message.source };
      }
      return { uid: Number(uid), size: message.size, internalDate: message.internalDate };
    },
  };
  return new ImapService({ getImapClient: async () => client } as unknown as IConnectionManager);
}

function register(imap: ImapService, readOnly: boolean) {
  let config: ToolConfig | undefined;
  let handler: ((args: ExportArgs) => Promise<ToolResult>) | undefined;
  const server = {
    registerTool: (
      name: string,
      cfg: ToolConfig,
      fn: (args: ExportArgs) => Promise<ToolResult>,
    ) => {
      if (name !== 'export_email') return;
      config = cfg;
      handler = fn;
    },
  };
  registerExportTools(server as never, imap, readOnly);
  if (!config || !handler) throw new Error('export_email was not registered');
  return { config, run: handler };
}

function exportTool(message: ServerMessage, readOnly = false) {
  return register(serviceFor(message), readOnly).run;
}

function inlineBytes(result: ToolResult): Buffer {
  const part = result.content.find((entry) => entry.text.includes(MARKER));
  if (!part) throw new Error(`no base64 part in ${JSON.stringify(result.content)}`);
  return Buffer.from(part.text.slice(part.text.indexOf(MARKER) + MARKER.length).trim(), 'base64');
}

function reason(result: ToolResult): string {
  const text = result.content[0]?.text ?? '';
  return text.slice(text.indexOf(': ') + 2);
}

async function withPinnedRoots<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-export-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-export-home-'));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    return await fn(cwd);
  } finally {
    cwdSpy.mockRestore();
    homeSpy.mockRestore();
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function withTimeZone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** A Latin-1 body sent as 8bit: 0xE9 and 0xFF are not valid UTF-8 on their own. */
const EIGHT_BIT_SOURCE = Buffer.concat([
  Buffer.from(
    'From: shop@example.com\r\nTo: me@example.test\r\nSubject: Receipt\r\n' +
      'Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf',
  ),
  Buffer.from([0xe9, 0x20, 0xff, 0x0d, 0x0a]),
]);

describe('export_email registration', () => {
  it('should default mailbox to INBOX and leave savePath optional', () => {
    const { config } = register(serviceFor({}), false);
    expect(z.object(config.inputSchema).parse({ account: ACCOUNT, id: UID })).toEqual({
      account: ACCOUNT,
      id: UID,
      mailbox: 'INBOX',
    });
  });

  it('should declare readOnlyHint false and destructiveHint true on a writable server', () => {
    const { config } = register(serviceFor({}), false);
    expect(config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('should declare readOnlyHint true and destructiveHint false when read_only is true', () => {
    const { config } = register(serviceFor({}), true);
    expect(config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});

describe('export_email in read_only mode', () => {
  it('should return isError and write nothing when savePath is set', async () => {
    const run = exportTool({ source: EIGHT_BIT_SOURCE }, true);
    await withPinnedRoots(async (cwd) => {
      const result = await run({
        account: ACCOUNT,
        id: UID,
        mailbox: 'INBOX',
        savePath: path.join(cwd, 'receipt.eml'),
      });
      expect(result.isError).toBe(true);
      expect(reason(result)).toBe('savePath is not allowed in read_only mode');
      expect(await fs.readdir(cwd)).toEqual([]);
    });
  });

  it('should return the source as base64 when savePath is omitted', async () => {
    const run = exportTool({ source: EIGHT_BIT_SOURCE }, true);
    const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX' });
    expect(inlineBytes(result).equals(EIGHT_BIT_SOURCE)).toBe(true);
  });
});

describe('export_email inline content', () => {
  it('should return bytes that are not valid UTF-8 unchanged', async () => {
    const run = exportTool({ source: EIGHT_BIT_SOURCE });
    const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX' });
    expect(inlineBytes(result).equals(EIGHT_BIT_SOURCE)).toBe(true);
  });

  it('should report message/rfc822 and the octet count in the metadata', async () => {
    const run = exportTool({ source: EIGHT_BIT_SOURCE });
    const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX' });
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      mimeType: 'message/rfc822',
      size: EIGHT_BIT_SOURCE.length,
    });
  });
});

describe('export_email size caps', () => {
  // Literal sizes: the tool description promises these numbers, so a boundary
  // derived from the exported constant would move with it.
  const FIVE_MIB = 5 * 1024 * 1024;
  const FIFTY_MIB = 50 * 1024 * 1024;

  it('should cap inline exports at 5 mebibytes', () => {
    expect(INLINE_MAX_BYTES).toBe(FIVE_MIB);
  });

  it('should export inline a message of exactly 5 MB', async () => {
    const source = Buffer.alloc(FIVE_MIB, 0x41);
    const run = exportTool({ size: source.length, source });
    const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX' });
    expect(inlineBytes(result).length).toBe(FIVE_MIB);
  });

  it('should return isError for an inline export one byte over 5 MB without fetching the source', async () => {
    const run = exportTool({ size: FIVE_MIB + 1 });
    const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX' });
    expect(result.isError).toBe(true);
    expect(reason(result)).toBe(`Email ${UID} is 5242881 bytes, over the 5242880-byte limit`);
  });

  it('should write a message over 5 MB when savePath is set', async () => {
    const source = Buffer.alloc(FIVE_MIB + 1, 0x42);
    const run = exportTool({ size: source.length, source });
    await withPinnedRoots(async (cwd) => {
      const dest = path.join(cwd, 'large.eml');
      const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX', savePath: dest });
      expect(result.isError).not.toBe(true);
      expect((await fs.stat(dest)).size).toBe(source.length);
    });
  });

  it('should return isError and leave no file when a savePath export is one byte over 50 MB', async () => {
    const run = exportTool({ size: FIFTY_MIB + 1 });
    await withPinnedRoots(async (cwd) => {
      const result = await run({
        account: ACCOUNT,
        id: UID,
        mailbox: 'INBOX',
        savePath: path.join('archive', 'large.eml'),
      });
      expect(result.isError).toBe(true);
      expect(reason(result)).toBe(`Email ${UID} is 52428801 bytes, over the 52428800-byte limit`);
      expect(await fs.readdir(cwd)).toEqual([]);
    });
  });

  it('should return isError and leave no file when the server sends more octets than its RFC822.SIZE', async () => {
    const run = exportTool({ size: 10, source: Buffer.alloc(FIFTY_MIB + 1, 0x43) });
    await withPinnedRoots(async (cwd) => {
      const result = await run({
        account: ACCOUNT,
        id: UID,
        mailbox: 'INBOX',
        savePath: path.join(cwd, 'large.eml'),
      });
      expect(result.isError).toBe(true);
      expect(reason(result)).toContain('over the 52428800-byte limit');
      expect(await fs.readdir(cwd)).toEqual([]);
    });
  });
});

describe('export_email default file name', () => {
  it('should save into a directory as the UTC day of INTERNALDATE and the uid', async () => {
    // At UTC+14 this instant is already 15 March; the name must not depend on the host zone.
    const run = exportTool({
      internalDate: new Date('2026-03-14T23:30:00.000Z'),
      source: EIGHT_BIT_SOURCE,
    });
    await withTimeZone('Pacific/Kiritimati', async () => {
      await withPinnedRoots(async (cwd) => {
        const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX', savePath: cwd });
        expect(result.isError).not.toBe(true);
        expect(await fs.readdir(cwd)).toEqual(['2026-03-14_42.eml']);
      });
    });
  });

  it('should return the on-disk name as the metadata filename', async () => {
    const run = exportTool({
      internalDate: new Date('2026-01-02T08:00:00.000Z'),
      source: EIGHT_BIT_SOURCE,
    });
    await withPinnedRoots(async (cwd) => {
      const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX', savePath: cwd });
      const payload = JSON.parse(result.content[0]?.text ?? '') as {
        filename?: string;
        savedTo?: string;
      };
      expect(payload.savedTo).toBe(path.join(cwd, payload.filename ?? ''));
    });
  });

  it('should read an INTERNALDATE that imapflow returns as a string', () => {
    expect(emlFilename('2026-03-14T09:30:00.000Z', '7')).toBe('2026-03-14_7.eml');
  });

  it('should name the file undated_<uid>.eml when the server sends no INTERNALDATE', () => {
    expect(emlFilename(undefined, '7')).toBe('undated_7.eml');
  });

  it('should keep the name one path segment when the uid holds separators', () => {
    const name = emlFilename(new Date('2026-03-14T09:30:00.000Z'), '../../etc/passwd');
    expect(name).not.toMatch(/[/\\]/);
    expect(name.endsWith('.eml')).toBe(true);
  });
});

describe('export_email savePath refusals', () => {
  type Setup = (cwd: string) => Promise<{ savePath: string; untouched: () => Promise<void> }>;

  const cases: [string, Setup][] = [
    [
      'a symlink',
      async (cwd) => {
        const outside = path.join(path.dirname(cwd), `${path.basename(cwd)}-target.eml`);
        await fs.writeFile(outside, 'original');
        const link = path.join(cwd, 'link.eml');
        await fs.symlink(outside, link);
        return {
          savePath: link,
          untouched: async () => {
            expect(await fs.readFile(outside, 'utf8')).toBe('original');
            await fs.rm(outside, { force: true });
          },
        };
      },
    ],
    [
      'an existing file',
      async (cwd) => {
        const dest = path.join(cwd, 'receipt.eml');
        await fs.writeFile(dest, 'original');
        return {
          savePath: dest,
          untouched: async () => {
            expect(await fs.readFile(dest, 'utf8')).toBe('original');
          },
        };
      },
    ],
    [
      'a path outside the working directory',
      async (cwd) => {
        const name = `${path.basename(cwd)}-escape.eml`;
        return {
          savePath: path.join('..', name),
          untouched: async () => {
            await expect(fs.access(path.join(path.dirname(cwd), name))).rejects.toThrow();
          },
        };
      },
    ],
  ];

  it.each(
    cases,
  )('should refuse %s with the same reason download_attachment gives', async (_label, setup) => {
    const run = exportTool({ source: EIGHT_BIT_SOURCE });
    let download: ((args: ExportArgs & { filename: string }) => Promise<ToolResult>) | undefined;
    registerAttachmentTools(
      {
        registerTool: (_name: string, _cfg: unknown, fn: typeof download) => {
          download = fn;
        },
      } as never,
      {
        downloadAttachment: async () => ({
          filename: 'receipt.eml',
          mimeType: 'message/rfc822',
          size: EIGHT_BIT_SOURCE.length,
          contentBase64: EIGHT_BIT_SOURCE.toString('base64'),
        }),
      } as never,
      false,
    );
    if (!download) throw new Error('download_attachment was not registered');
    const downloadTool = download;

    await withPinnedRoots(async (cwd) => {
      const { savePath, untouched } = await setup(cwd);
      const args = { account: ACCOUNT, id: UID, mailbox: 'INBOX', savePath };

      const exported = await run(args);
      const downloaded = await downloadTool({ ...args, filename: 'receipt.eml' });

      expect(exported.isError).toBe(true);
      expect(reason(exported)).toBe(reason(downloaded));
      await untouched();
    });
  });
});
