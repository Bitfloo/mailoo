/**
 * MCP tool: list_mailboxes
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

export default function registerMailboxesTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'list_mailboxes',
    {
      title: 'List Mailboxes',
      description:
        'List all mailbox folders for an account with unread counts and special-use flags. Use list_accounts first to get the account name.',
      inputSchema: {
        account: z.string().describe('Account name from list_accounts'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account }) => {
      try {
        const mailboxes = await imapService.listMailboxes(account);

        const lines = mailboxes.map((mb) => {
          const badge = mb.unseenMessages > 0 ? ` (${mb.unseenMessages} unread)` : '';
          const special = mb.specialUse ? ` [${mb.specialUse}]` : '';
          return `• ${mb.path}${special} — ${mb.totalMessages} messages${badge}`;
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: lines.join('\n') || 'No mailboxes found.',
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to list mailboxes: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
