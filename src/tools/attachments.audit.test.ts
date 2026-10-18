import path from 'node:path';

import { captureDownload, withCwdTempDir } from '../test-support/attachment-harness.js';
import { readAuditEntries } from '../test-support/audit-home.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

describe('download_attachment audit log', () => {
  /** What imapService.downloadAttachment returns for a 4-byte PDF part. */
  const PDF_PART = {
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    size: 4,
    contentBase64: Buffer.from('%PDF').toString('base64'),
  };
  const ARGS = { account: 'personal', id: '42', mailbox: 'INBOX', filename: 'invoice.pdf' };

  it('should record a saved attachment with the requested and the written path', async () => {
    const run = captureDownload({ downloadAttachment: async () => PDF_PART }, false);

    await withCwdTempDir(async (dir) => {
      await run({ ...ARGS, savePath: dir });

      expect((await readAuditEntries(auditHome)).at(-1)).toEqual({
        ts: expect.any(String),
        tool: 'download_attachment',
        account: 'personal',
        params: {
          id: '42',
          mailbox: 'INBOX',
          filename: 'invoice.pdf',
          savePath: dir,
          savedTo: path.join(dir, 'invoice.pdf'),
        },
        result: 'ok',
      });
    });
  });

  it('should record a refused savePath as an error with the reason', async () => {
    const run = captureDownload({ downloadAttachment: async () => PDF_PART }, false);

    await withCwdTempDir(async () => {
      await run({ ...ARGS, savePath: path.join('..', 'invoice.pdf') });

      expect((await readAuditEntries(auditHome)).at(-1)).toMatchObject({
        tool: 'download_attachment',
        params: { savePath: path.join('..', 'invoice.pdf') },
        result: 'error',
        error: 'savePath must stay under the working directory',
      });
    });
  });

  it('should write no entry when the attachment comes back as base64', async () => {
    const run = captureDownload({ downloadAttachment: async () => PDF_PART }, false);
    const before = (await readAuditEntries(auditHome)).length;

    await run(ARGS);

    expect(await readAuditEntries(auditHome)).toHaveLength(before);
  });

  it('should write no entry when a base64 download fails', async () => {
    const run = captureDownload(
      {
        downloadAttachment: async () => {
          throw new Error('Attachment "invoice.pdf" not found. Available: none');
        },
      },
      false,
    );
    const before = (await readAuditEntries(auditHome)).length;

    await run(ARGS);

    expect(await readAuditEntries(auditHome)).toHaveLength(before);
  });

  it('should write no entry when read_only refuses savePath', async () => {
    const run = captureDownload({ downloadAttachment: async () => PDF_PART }, true);
    const before = (await readAuditEntries(auditHome)).length;

    await withCwdTempDir(async (dir) => {
      await run({ ...ARGS, savePath: dir });
    });

    expect(await readAuditEntries(auditHome)).toHaveLength(before);
  });
});
