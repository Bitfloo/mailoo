/**
 * Turn outgoing attachment inputs into bytes.
 *
 * Nodemailer opens `path` itself, including http(s) and data URLs, and it
 * follows symlinks. Callers get `content` only, after the path has been
 * checked.
 */

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertAllowedLocalPath,
  hiddenSegment,
  isDisallowedLocalPath,
  realpathPreservingCase,
  specificRoots,
} from '../safety/local-paths.js';
import type { OutgoingAttachment } from '../types/index.js';

/** Same cap as copying an attachment from an existing message. */
export const MAX_OUTGOING_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface ResolvedOutgoingAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface ResolveOutgoingAttachmentOptions {
  /** Working directory that may contain attachment files. Defaults to `process.cwd()`. */
  root?: string;
  /** Home directory that may contain attachment files. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Per-attachment and combined cap. Defaults to {@link MAX_OUTGOING_ATTACHMENT_BYTES}. */
  maxBytes?: number;
  /**
   * Copy a part from an existing message. Omitted for drafts, which do not
   * accept that shape — those entries are skipped.
   */
  downloadMessageAttachment?: (
    emailId: string,
    mailbox: string,
    filename: string,
    maxBytes: number,
  ) => Promise<{ filename: string; mimeType: string; contentBase64: string }>;
}

const URL_SCHEME = /^(?:https?|file|data|ftp|ftps|mailto|sftp):/i;

function byteLimit(options: ResolveOutgoingAttachmentOptions): number {
  return options.maxBytes ?? MAX_OUTGOING_ATTACHMENT_BYTES;
}

function assertSize(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new Error(`Attachment exceeds the ${maxBytes} byte limit`);
  }
}

function safeFilename(name: string | undefined, fallback: string): string {
  const raw = (name ?? '').replace(/[\r\n\0]/g, '').trim();
  const base = path.posix.basename(raw.replaceAll('\\', '/'));
  if (base && base !== '.' && base !== '..') return base;
  const fallbackBase = path.posix.basename(fallback.replaceAll('\\', '/'));
  if (!fallbackBase || fallbackBase === '.' || fallbackBase === '..') return 'attachment';
  return fallbackBase;
}

function isRemoteOrFileUrl(value: string): boolean {
  if (value.startsWith('//') || value.startsWith('\\\\')) return true;
  return URL_SCHEME.test(value.replaceAll('\\', '/'));
}

function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir, input.slice(2));
  }
  if (input.startsWith('~')) {
    throw new Error('Attachment path must be a local file');
  }
  return input;
}

async function readExact(fh: fs.FileHandle, size: number): Promise<Buffer> {
  const buf = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    // A single read can return short; stop once `size` bytes are in hand.
    // eslint-disable-next-line no-await-in-loop
    const { bytesRead } = await fh.read(buf, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) {
    throw new Error('Attachment path is not allowed');
  }
  return buf;
}

async function readLocalFile(
  filePath: string,
  options: ResolveOutgoingAttachmentOptions,
  maxBytes: number,
): Promise<{ filename: string; content: Buffer }> {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes('\0') || isRemoteOrFileUrl(trimmed)) {
    throw new Error('Attachment path must be a local file');
  }
  if (hiddenSegment(trimmed)) {
    throw new Error('Attachment path is not allowed');
  }

  const cwdRoot = path.resolve(options.root ?? process.cwd());
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const resolved = path.resolve(cwdRoot, expandHome(trimmed, homeDir));
  if (isDisallowedLocalPath(resolved, homeDir)) {
    throw new Error('Attachment path is not allowed');
  }

  const roots = await specificRoots(cwdRoot, homeDir);
  let homeReal = homeDir;
  try {
    homeReal = await realpathPreservingCase(homeDir);
  } catch {
    // A missing home has no application-data tree to compare.
  }
  let real: string;
  try {
    real = await realpathPreservingCase(resolved);
  } catch {
    throw new Error('Attachment path is not allowed');
  }
  assertAllowedLocalPath(real, roots, homeReal);

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fh: fs.FileHandle;
  try {
    // Open flags are a bitmask; O_NOFOLLOW refuses a final-component symlink swapped in after the check.
    // eslint-disable-next-line no-bitwise
    fh = await fs.open(real, fsConstants.O_RDONLY | noFollow);
  } catch {
    throw new Error('Attachment path is not allowed');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error('Attachment path must be a regular file');
    }
    assertSize(st.size, maxBytes);
    const content = await readExact(fh, st.size);
    return { filename: safeFilename(undefined, path.basename(resolved)), content };
  } finally {
    await fh.close();
  }
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  const maxChars = Math.ceil(maxBytes / 3) * 4 + 4;
  if (value.length > maxChars) {
    throw new Error(`Attachment exceeds the ${maxBytes} byte limit`);
  }
  const buf = Buffer.from(value, 'base64');
  assertSize(buf.length, maxBytes);
  return buf;
}

function withContentType(
  part: { filename: string; content: Buffer },
  contentType: string | undefined,
): ResolvedOutgoingAttachment {
  if (contentType === undefined) return part;
  return { ...part, contentType };
}

async function resolveOne(
  att: OutgoingAttachment,
  options: ResolveOutgoingAttachmentOptions,
  maxBytes: number,
): Promise<ResolvedOutgoingAttachment | undefined> {
  if (att.path) {
    const loaded = await readLocalFile(att.path, options, maxBytes);
    return withContentType(
      {
        filename: safeFilename(att.filename, loaded.filename),
        content: loaded.content,
      },
      att.contentType,
    );
  }
  if (att.base64) {
    return withContentType(
      {
        filename: safeFilename(att.filename, 'attachment'),
        content: decodeBase64(att.base64, maxBytes),
      },
      att.contentType,
    );
  }
  if (att.emailId && att.filename && options.downloadMessageAttachment) {
    const downloaded = await options.downloadMessageAttachment(
      att.emailId,
      att.mailbox ?? 'INBOX',
      att.filename,
      maxBytes,
    );
    return withContentType(
      {
        filename: safeFilename(downloaded.filename, att.filename),
        content: decodeBase64(downloaded.contentBase64, maxBytes),
      },
      downloaded.mimeType,
    );
  }
  if (att.emailId && att.filename) {
    return undefined;
  }
  throw new Error('Each attachment needs path, base64, or emailId+filename');
}

export async function resolveOutgoingAttachments(
  attachments: readonly OutgoingAttachment[] | undefined,
  options: ResolveOutgoingAttachmentOptions = {},
): Promise<ResolvedOutgoingAttachment[]> {
  if (!attachments?.length) return [];
  const maxBytes = byteLimit(options);
  const parts: ResolvedOutgoingAttachment[] = [];
  let total = 0;
  // eslint-disable-next-line no-restricted-syntax -- combined byte cap must see each attachment before the next read
  for (const att of attachments) {
    // eslint-disable-next-line no-await-in-loop
    const part = await resolveOne(att, options, maxBytes);
    if (part) {
      total += part.content.length;
      assertSize(total, maxBytes);
      parts.push(part);
    }
  }
  return parts;
}
