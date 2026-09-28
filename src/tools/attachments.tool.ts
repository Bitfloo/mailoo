/**
 * MCP tool: download_attachment
 */

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  broadRootPaths,
  isDisallowedLocalPath,
  isInsideRoot,
  realpathPreservingCase,
  resolvedHome,
  sanitizeAttachmentFilename,
  specificRoot,
} from '../safety/local-paths.js';
import type ImapService from '../services/imap.service.js';

/** Max size when streaming to disk (base64 responses stay at 5MB). */
export const SAVE_PATH_MAX_BYTES = 50 * 1024 * 1024;

const OUTSIDE_ROOT = 'savePath must stay under the working directory';
const SAVE_NOT_ALLOWED = 'savePath is not allowed';

export function downloadRoot(): string {
  return path.resolve(process.cwd());
}

/** Reject destinations that escape `root`. */
export function assertPathInsideRoot(resolvedPath: string, root: string): void {
  if (!isInsideRoot(resolvedPath, root)) {
    throw new Error(OUTSIDE_ROOT);
  }
}

function errnoOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function isEnoent(err: unknown): boolean {
  return errnoOf(err) === 'ENOENT';
}

export function attachmentOpenFailure(err: unknown): Error {
  const code = errnoOf(err);
  if (code === 'ELOOP') return new Error('savePath must not be a symlink');
  if (code === 'EEXIST') return new Error('savePath already exists');
  return new Error(`Could not write savePath (${code ?? 'UNKNOWN'})`);
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
    // Node's message includes the absolute path.
    if (!isEnoent(err)) throw attachmentOpenFailure(err);
  }
  if (!existing) {
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (err) {
      // A parallel save into the same new directory created it first.
      if (errnoOf(err) !== 'EEXIST') throw attachmentOpenFailure(err);
      try {
        existing = await fs.lstat(current);
      } catch (statErr) {
        if (!isEnoent(statErr)) throw attachmentOpenFailure(statErr);
      }
    }
    if (!existing) return current;
  }
  // lstat, not stat: a directory symlink would otherwise be followed out of root.
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new Error(OUTSIDE_ROOT);
  }
  assertPathInsideRoot(await realpathPreservingCase(current), rootReal);
  return current;
}

async function resolveExistingPrefix(filePath: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(filePath);
  const filesystemRoot = path.parse(current).root;
  while (current !== filesystemRoot) {
    try {
      // eslint-disable-next-line no-await-in-loop -- the new file is not on disk, so the parent is the next candidate
      const real = await realpathPreservingCase(current);
      return path.join(real, ...missing);
    } catch (err) {
      // A name past PATH_MAX is not an existing directory. Keep walking so open() can report ENAMETOOLONG.
      if (errnoOf(err) !== 'ENOENT' && errnoOf(err) !== 'ENAMETOOLONG') throw err;
      missing.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
  return path.join(current, ...missing);
}

async function assertSaveDestinationAllowed(
  dest: string,
  rootReal: string,
  homeDir: string,
): Promise<void> {
  const homeReal = await resolvedHome(homeDir);
  if (isDisallowedLocalPath(dest, homeDir) || isDisallowedLocalPath(dest, homeReal)) {
    throw new Error(SAVE_NOT_ALLOWED);
  }
  const realDest = await resolveExistingPrefix(dest);
  if (!isInsideRoot(realDest, rootReal)) {
    throw new Error(OUTSIDE_ROOT);
  }
  if (isDisallowedLocalPath(realDest, homeDir) || isDisallowedLocalPath(realDest, homeReal)) {
    throw new Error(SAVE_NOT_ALLOWED);
  }
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
  const homeDir = path.resolve(os.homedir());
  const broad = await broadRootPaths();
  // A root of / or a direct child such as /tmp would let savePath create files anywhere under it.
  if ((await specificRoot(rootLogical, broad)) === undefined) {
    throw new Error(SAVE_NOT_ALLOWED);
  }
  const rootReal = await realpathPreservingCase(rootLogical);
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
    // Filesystem errors include the absolute path. Refusals thrown above have no errno.
    if (!isEnoent(err)) {
      if (errnoOf(err) !== undefined) throw attachmentOpenFailure(err);
      throw err;
    }
  }

  const parent = path.dirname(dest);
  await assertSaveDestinationAllowed(dest, rootReal, homeDir);
  await mkdirInside(parent, rootLogical, rootReal);
  const parentReal = await realpathPreservingCase(parent);
  assertPathInsideRoot(path.join(parentReal, path.basename(dest)), rootReal);

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  // Open flags are a bitmask; O_EXCL refuses an existing file and O_NOFOLLOW refuses a symlink.
  // eslint-disable-next-line no-bitwise
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(dest, flags, 0o600);
  } catch (err) {
    throw attachmentOpenFailure(err);
  }
  try {
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
  return dest;
}

export default function registerAttachmentTools(
  server: McpServer,
  imapService: ImapService,
  readOnly: boolean,
): void {
  server.registerTool(
    'download_attachment',
    {
      title: 'Download Attachment',
      description:
        'Download an email attachment by filename. First use get_email to see available attachments and their filenames. ' +
        'Returns base64-encoded content for files ≤5MB. Pass savePath to write the file to disk instead (up to 50MB) and skip base64.',
      inputSchema: {
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
      annotations: {
        // savePath writes disk on a writable server. read_only rejects it, so the hint matches that server.
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, id, mailbox, filename, savePath }) => {
      try {
        if (readOnly && savePath !== undefined) {
          throw new Error('savePath is not allowed in read_only mode');
        }
        const maxSize = savePath ? SAVE_PATH_MAX_BYTES : 5 * 1024 * 1024;
        const result = await imapService.downloadAttachment(
          account,
          id,
          mailbox,
          filename,
          maxSize,
        );

        // Filename and base64 stay raw. The fence is letters and "_", which
        // base64 decoding accepts, and send/download need the exact name.
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
