/**
 * MCP tool: download_attachment
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

/** Max size when streaming to disk (base64 responses stay at 5MB). */
export const SAVE_PATH_MAX_BYTES = 50 * 1024 * 1024;

export function downloadRoot(): string {
  return path.resolve(process.cwd());
}

/** Reject destinations that escape `root` via `..` or an absolute path outside it. */
export function assertPathInsideRoot(resolvedPath: string, root: string): void {
  const relative = path.relative(root, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('savePath must stay under the working directory');
  }
}

export async function writeAttachmentFile(
  savePath: string,
  filename: string,
  content: Buffer,
): Promise<string> {
  if (!savePath.trim()) {
    throw new Error('savePath must not be empty');
  }
  if (savePath.includes('\0')) {
    throw new Error('savePath must not contain null bytes');
  }

  const root = downloadRoot();
  const resolved = path.resolve(savePath);
  assertPathInsideRoot(resolved, root);

  let dest = resolved;
  try {
    const st = await fs.stat(resolved);
    if (st.isDirectory()) {
      dest = path.join(resolved, filename.replace(/[/\\?%*:|"<>]/g, '_'));
    }
  } catch {
    const dir = path.dirname(resolved);
    assertPathInsideRoot(dir, root);
    await fs.mkdir(dir, { recursive: true });
  }

  assertPathInsideRoot(dest, root);
  await fs.writeFile(dest, content);
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
