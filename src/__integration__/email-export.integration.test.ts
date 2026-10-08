import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import createServer from '../server.js';
import registerExportTools from '../tools/export.tool.js';
import type { TestServices } from './helpers/index.js';
import { buildTestAccount, createTestServices, TEST_ACCOUNT_NAME } from './helpers/index.js';

interface TextToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function isTextToolResult(result: unknown): result is TextToolResult {
  if (typeof result !== 'object' || result === null || !('content' in result)) return false;
  return Array.isArray(result.content);
}

const BASE64_MARKER = '--- Base64 Content ---\n';

/** APPEND sets INTERNALDATE, so the default file name does not depend on the clock. */
const INTERNAL_DATE = new Date('2026-03-14T09:30:00.000Z');

/**
 * A vendor receipt whose only copy of the invoice is the HTML body. Folded
 * headers, quoted-printable soft breaks and a trailing space are the bytes a
 * MIME re-serialisation would rewrite.
 */
function receiptSource(tag: string): Buffer {
  return Buffer.from(
    [
      'Return-Path: <billing@example.com>',
      `Message-ID: <receipt-${tag}@example.com>`,
      'Date: Sat, 14 Mar 2026 10:30:00 +0100',
      'From: Example Shop <billing@example.com>',
      'To: Integration Test <test@localhost>',
      `Subject: =?UTF-8?Q?Your_receipt_${tag}_=E2=80=93_order?=`,
      ' 10442 ',
      'X-Mailer: Example Billing 4.2',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative;',
      '\tboundary="b1_receipt"',
      '',
      '--b1_receipt',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Order 10442 =E2=80=93 total 12,50 =E2=82=AC ',
      '',
      '--b1_receipt',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<table><tr><td>Order 10442</td><td>12,50 =E2=82=AC</td></tr></table><p>Paid=',
      ' by card</p>',
      '',
      '--b1_receipt--',
      '',
    ].join('\r\n'),
  );
}

describe('export_email against GreenMail', () => {
  let services: TestServices;
  let seq = 0;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  async function appendReceipt(
    flags: string[] = [],
  ): Promise<{ uid: string; source: Buffer; tag: string }> {
    seq += 1;
    const tag = `${process.pid}-${seq}`;
    const source = receiptSource(tag);
    const client = await services.connections.getImapClient(TEST_ACCOUNT_NAME);
    const appended = await client.append('INBOX', source, flags, INTERNAL_DATE);
    if (!appended || !appended.uid) throw new Error('APPEND returned no UID (UIDPLUS)');
    return { uid: String(appended.uid), source, tag };
  }

  async function storedFlags(uid: string): Promise<string[]> {
    const client = await services.connections.getImapClient(TEST_ACCOUNT_NAME);
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(uid, { flags: true }, { uid: true });
      if (!msg) throw new Error(`FETCH FLAGS returned nothing for UID ${uid}`);
      return [...(msg.flags ?? [])].map(String).sort();
    } finally {
      lock.release();
    }
  }

  async function callExport(args: Record<string, unknown>): Promise<TextToolResult> {
    const server = createServer();
    registerExportTools(server, services.imapService, false);
    const client = new Client({ name: 'mailoo-export-email', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await client.callTool({ name: 'export_email', arguments: args });
      if (!isTextToolResult(result)) throw new Error('tool result has no text content');
      return result;
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  }

  function inlineBytes(result: TextToolResult): Buffer {
    const part = result.content.find((entry) => entry.text?.includes(BASE64_MARKER));
    if (!part?.text) throw new Error(`no base64 part in ${JSON.stringify(result.content)}`);
    const encoded = part.text.slice(part.text.indexOf(BASE64_MARKER) + BASE64_MARKER.length);
    return Buffer.from(encoded.trim(), 'base64');
  }

  /** writeAttachmentFile confines savePath to process.cwd() and checks $HOME. */
  async function withPinnedCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-export-cwd-'));
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

  it('should return the appended RFC 822 bytes unchanged when savePath is omitted', async () => {
    const { uid, source } = await appendReceipt();

    const result = await callExport({ account: TEST_ACCOUNT_NAME, id: uid, mailbox: 'INBOX' });

    expect(result.isError).not.toBe(true);
    expect(inlineBytes(result).equals(source)).toBe(true);
  });

  it('should leave \\Seen unset when export_email reads an unread message', async () => {
    const { uid } = await appendReceipt();
    expect(await storedFlags(uid)).not.toContain('\\Seen');

    const result = await callExport({ account: TEST_ACCOUNT_NAME, id: uid, mailbox: 'INBOX' });

    expect(result.isError).not.toBe(true);
    expect(await storedFlags(uid)).not.toContain('\\Seen');
  });

  it('should leave every stored flag identical when export_email reads a flagged, answered message with a keyword', async () => {
    const { uid } = await appendReceipt(['\\Flagged', '\\Answered', '$Invoice']);
    const before = await storedFlags(uid);
    // A seed that dropped the flags would make the comparison below vacuous.
    expect(before).toEqual(expect.arrayContaining(['$Invoice', '\\Answered', '\\Flagged']));

    const result = await callExport({ account: TEST_ACCOUNT_NAME, id: uid, mailbox: 'INBOX' });

    expect(result.isError).not.toBe(true);
    expect(await storedFlags(uid)).toEqual(before);
  });

  it('should write the exported bytes to savePath when savePath names a new file', async () => {
    const { uid, source } = await appendReceipt();
    await withPinnedCwd(async (cwd) => {
      const dest = path.join(cwd, 'archive', 'receipt.eml');

      const result = await callExport({
        account: TEST_ACCOUNT_NAME,
        id: uid,
        mailbox: 'INBOX',
        savePath: dest,
      });

      expect(result.isError).not.toBe(true);
      expect((await fs.readFile(dest)).equals(source)).toBe(true);
    });
  });

  it('should name the file <INTERNALDATE>_<uid>.eml when savePath is a directory', async () => {
    const { uid } = await appendReceipt();
    await withPinnedCwd(async (cwd) => {
      const result = await callExport({
        account: TEST_ACCOUNT_NAME,
        id: uid,
        mailbox: 'INBOX',
        savePath: cwd,
      });

      expect(result.isError).not.toBe(true);
      expect(await fs.readdir(cwd)).toEqual([`2026-03-14_${uid}.eml`]);
    });
  });

  it('should return isError and keep the original file when savePath already exists', async () => {
    const { uid } = await appendReceipt();
    await withPinnedCwd(async (cwd) => {
      const dest = path.join(cwd, 'receipt.eml');
      await fs.writeFile(dest, 'original');

      const result = await callExport({
        account: TEST_ACCOUNT_NAME,
        id: uid,
        mailbox: 'INBOX',
        savePath: dest,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('savePath already exists');
      expect(await fs.readFile(dest, 'utf8')).toBe('original');
    });
  });

  it('should return isError and create no file when savePath leaves the working directory', async () => {
    const { uid, tag } = await appendReceipt();
    await withPinnedCwd(async (cwd) => {
      const name = `mailoo-export-escape-${tag}.eml`;
      const escaped = path.join(path.dirname(cwd), name);

      const result = await callExport({
        account: TEST_ACCOUNT_NAME,
        id: uid,
        mailbox: 'INBOX',
        savePath: path.join('..', name),
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('savePath must stay under the working directory');
      await expect(fs.access(escaped)).rejects.toThrow();
    });
  });

  it('should refuse a message one byte over the cap', async () => {
    const { uid, source } = await appendReceipt();

    await expect(
      services.imapService.exportEmail(TEST_ACCOUNT_NAME, uid, 'INBOX', source.length - 1),
    ).rejects.toThrow(
      `Email ${uid} is ${source.length} bytes, over the ${source.length - 1}-byte limit`,
    );
  });

  it('should export a message exactly at the cap', async () => {
    const { uid, source } = await appendReceipt();

    const exported = await services.imapService.exportEmail(
      TEST_ACCOUNT_NAME,
      uid,
      'INBOX',
      source.length,
    );

    expect(exported.source.equals(source)).toBe(true);
  });
});
