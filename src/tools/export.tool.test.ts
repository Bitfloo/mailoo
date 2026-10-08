import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  ACCOUNT,
  EIGHT_BIT_SOURCE,
  exportTool,
  inlineBytes,
  reason,
  register,
  serviceFor,
  UID,
  withPinnedRoots,
} from '../test-support/export-tool-harness.js';
import { INLINE_MAX_BYTES } from './export.tool.js';

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

  it('should report the received octet count as size when RFC822.SIZE disagrees', async () => {
    const run = exportTool({ size: 10, source: EIGHT_BIT_SOURCE });
    const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX' });
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      size: EIGHT_BIT_SOURCE.length,
    });
  });

  it('should report sizeHuman in whole KiB as download_attachment does', async () => {
    const source = Buffer.alloc(50 * 1024, 0x41);
    const run = exportTool({ size: source.length, source });
    const result = await run({ account: ACCOUNT, id: UID, mailbox: 'INBOX' });
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({ sizeHuman: '50KB' });
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
