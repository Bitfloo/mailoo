import fs from 'node:fs/promises';
import path from 'node:path';

import { emlFilename } from '../services/imap.service.js';
import type { ExportArgs, ToolResult } from '../test-support/export-tool-harness.js';
import {
  ACCOUNT,
  EIGHT_BIT_SOURCE,
  exportTool,
  reason,
  UID,
  withPinnedRoots,
  withTimeZone,
} from '../test-support/export-tool-harness.js';
import registerAttachmentTools from './attachments.tool.js';

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
