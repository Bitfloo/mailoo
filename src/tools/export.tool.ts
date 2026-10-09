/**
 * MCP tool: export_email
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';
import {
  INLINE_MAX_BYTES,
  SAVE_PATH_MAX_BYTES,
  SAVE_PATH_READ_ONLY_MESSAGE,
  savePathLimitSentence,
  sizeHuman,
  writeAttachmentFile,
} from './attachments.tool.js';

export { INLINE_MAX_BYTES };

const exportInputSchema = {
  account: z.string().describe('Account name from list_accounts'),
  id: z.string().describe('Email ID (UID) from list_emails or get_email'),
  mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
  savePath: z
    .string()
    .optional()
    .describe(
      'If set, write the .eml to this path, or into this directory as <YYYY-MM-DD>_<uid>.eml (UTC date of INTERNALDATE), and return metadata only — no base64.',
    ),
};

function exportToolDescription(): string {
  return (
    'Export one email as its raw RFC 822 source (.eml) — headers, body, and attachments, byte for byte as the server stores it. ' +
    'Use it to archive the message itself, for example a receipt that is only in the mail body. ' +
    `Does NOT mark the email as seen or change any flag. ${savePathLimitSentence('messages', 'the .eml file')}`
  );
}

interface ExportArgs {
  account: string;
  id: string;
  mailbox: string;
  savePath?: string;
}

async function exportEmail(
  imapService: ImapService,
  readOnly: boolean,
  args: ExportArgs,
): Promise<CallToolResult> {
  const { account, id, mailbox, savePath } = args;
  try {
    if (readOnly && savePath !== undefined) {
      throw new Error(SAVE_PATH_READ_ONLY_MESSAGE);
    }
    const maxSize = savePath ? SAVE_PATH_MAX_BYTES : INLINE_MAX_BYTES;
    const result = await imapService.exportEmail(account, id, mailbox, maxSize);
    const meta = {
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.size,
      sizeHuman: sizeHuman(result.size),
    };

    if (savePath) {
      const savedTo = await writeAttachmentFile(savePath, result.filename, result.source);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...meta, savedTo }, null, 2) }],
      };
    }

    // Base64 stays unfenced: the fence is letters and "_", which base64 decoding accepts.
    return {
      content: [
        { type: 'text', text: JSON.stringify(meta, null, 2) },
        { type: 'text', text: `\n--- Base64 Content ---\n${result.source.toString('base64')}` },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Failed to export email: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
}

export default function registerExportTools(
  server: McpServer,
  imapService: ImapService,
  readOnly: boolean,
): void {
  server.registerTool(
    'export_email',
    {
      title: 'Export Email',
      description: exportToolDescription(),
      inputSchema: exportInputSchema,
      annotations: {
        // savePath writes disk on a writable server. read_only rejects it, so the hint matches that server.
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => exportEmail(imapService, readOnly, args),
  );
}
