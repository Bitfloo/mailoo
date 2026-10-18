import fs from 'node:fs/promises';
import path from 'node:path';

import type ImapService from '../services/imap.service.js';
import { withCwdTempDir } from '../test-support/attachment-harness.js';
import registerAttachmentTools, {
  INLINE_MAX_BYTES,
  SAVE_PATH_MAX_BYTES,
} from './attachments.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

describe('download_attachment tool', () => {
  it('sets the savePath size cap at 50 mebibytes', () => {
    expect(SAVE_PATH_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it('sets the inline base64 size cap at 5 mebibytes', () => {
    expect(INLINE_MAX_BYTES).toBe(5 * 1024 * 1024);
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
      INLINE_MAX_BYTES,
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
      INLINE_MAX_BYTES,
    );
  });
});
