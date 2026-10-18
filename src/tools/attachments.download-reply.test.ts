import path from 'node:path';

import { captureDownload, withCwdTempDir } from '../test-support/attachment-harness.js';
import registerEmailsTools from './emails.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

describe('download_attachment tool', () => {
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
