/**
 * MCP tool: download_attachment
 */

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

/** Max size when streaming to disk (base64 responses stay at 5MB). */
export const SAVE_PATH_MAX_BYTES = 50 * 1024 * 1024;

const OUTSIDE_ROOT = 'savePath must stay under the working directory';

export function downloadRoot(): string {
  return path.resolve(process.cwd());
}

/**
 * Reject destinations that escape `root`.
 * A name such as `..notes.txt` is one segment and stays inside `root`.
 */
export function assertPathInsideRoot(resolvedPath: string, root: string): void {
  const relative = path.relative(root, resolvedPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(OUTSIDE_ROOT);
  }
}

const FILENAME_UNSAFE = new Set(['/', '\\', '?', '%', '*', ':', '|', '"', '<', '>']);

function isUnsafeFilenameChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f || FILENAME_UNSAFE.has(char);
}

/** One path segment. `..`, separators, and control characters cannot escape the directory. */
export function sanitizeAttachmentFilename(filename: string): string {
  const base = path.posix.basename(filename.replaceAll('\\', '/').replaceAll('\0', ''));
  const cleaned = Array.from(base)
    .map((char) => (isUnsafeFilenameChar(char) ? '_' : char))
    .join('')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned.slice(0, 200);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

async function ensurePathSegment(parent: string, part: string, rootReal: string): Promise<string> {
  if (part === '.' || part === '..') {
    throw new Error(OUTSIDE_ROOT);
  }
  const current = path.join(parent, part);
  let existing: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    existing = await fs.lstat(current);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  if (!existing) {
    await fs.mkdir(current, { mode: 0o700 });
    return current;
  }
  // lstat, not stat: a directory symlink would otherwise be followed out of root.
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new Error(OUTSIDE_ROOT);
  }
  assertPathInsideRoot(await fs.realpath(current), rootReal);
  return current;
}

async function mkdirInside(dir: string, rootLogical: string, rootReal: string): Promise<void> {
  assertPathInsideRoot(dir, rootLogical);
  const relative = path.relative(rootLogical, dir);
  const parts = relative === '' ? [] : relative.split(path.sep);
  // Sequential so each segment is checked before the next one is created.
  await parts.reduce(async (previous, part) => {
    const parent = await previous;
    return ensurePathSegment(parent, part, rootReal);
  }, Promise.resolve(rootLogical));
}

export async function writeAttachmentFile(
  savePath: string,
  filename: string,
  content: Buffer,
): Promise<string> {
  if (!savePath.trim()) {
    throw new Error('savePath must not be empty');
  }
  if (savePath.includes('\0') || filename.includes('\0')) {
    throw new Error('savePath must not contain null bytes');
  }

  const rootLogical = downloadRoot();
  const rootReal = await fs.realpath(rootLogical);
  const resolved = path.resolve(rootLogical, savePath);
  assertPathInsideRoot(resolved, rootLogical);

  const safeName = sanitizeAttachmentFilename(filename);
  let dest = resolved;
  try {
    const st = await fs.lstat(resolved);
    if (st.isSymbolicLink()) {
      throw new Error(OUTSIDE_ROOT);
    }
    if (st.isDirectory()) {
      dest = path.join(resolved, safeName);
      assertPathInsideRoot(dest, rootLogical);
    } else if (st.isFile()) {
      throw new Error('savePath already exists');
    } else {
      throw new Error(OUTSIDE_ROOT);
    }
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  const parent = path.dirname(dest);
  await mkdirInside(parent, rootLogical, rootReal);
  const parentReal = await fs.realpath(parent);
  assertPathInsideRoot(path.join(parentReal, path.basename(dest)), rootReal);

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  // Open flags are a bitmask; O_EXCL refuses an existing file and O_NOFOLLOW refuses a symlink.
  // eslint-disable-next-line no-bitwise
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(dest, flags, 0o600);
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined;
    if (code === 'EEXIST') {
      throw new Error('savePath already exists');
    }
    throw new Error(OUTSIDE_ROOT);
  }
  try {
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
  return dest;
}

export default function registerAttachmentTools(server: McpServer, imapService: ImapService): void {
  server.tool(
    'download_attachment',
    'Download an email attachment by filename. First use get_email to see available attachments and their filenames. ' +
      'Returns base64-encoded content for files ≤5MB. Pass savePath to write the file to disk instead (up to 50MB) and skip base64.',
    {
      account: z.string().describe('Account name from list_accounts'),
      id: z.string().describe('Email ID (UID) from list_emails or get_email'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
      filename: z.string().describe('Exact attachment filename (from get_email metadata)'),
      savePath: z
        .string()
        .optional()
        .describe(
          'If set, write the decoded file to this path (or directory) and return metadata only — no base64.',
        ),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ account, id, mailbox, filename, savePath }) => {
      try {
        const maxSize = savePath ? SAVE_PATH_MAX_BYTES : 5 * 1024 * 1024;
        const result = await imapService.downloadAttachment(
          account,
          id,
          mailbox,
          filename,
          maxSize,
        );

        if (savePath) {
          const savedTo = await writeAttachmentFile(
            savePath,
            result.filename,
            Buffer.from(result.contentBase64, 'base64'),
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    filename: result.filename,
                    mimeType: result.mimeType,
                    size: result.size,
                    sizeHuman: `${Math.round(result.size / 1024)}KB`,
                    savedTo,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  filename: result.filename,
                  mimeType: result.mimeType,
                  size: result.size,
                  sizeHuman: `${Math.round(result.size / 1024)}KB`,
                },
                null,
                2,
              ),
            },
            {
              type: 'text' as const,
              text: `\n--- Base64 Content ---\n${result.contentBase64}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to download attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
