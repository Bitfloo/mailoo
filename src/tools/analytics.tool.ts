/**
 * MCP Tool: get_email_stats
 *
 * Provides email analytics and statistics for a mailbox.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { delimitUntrusted } from '../safety/untrusted-content.js';
import type ImapService from '../services/imap.service.js';

export default function registerAnalyticsTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'get_email_stats',
    {
      title: 'Get Email Statistics',
      description:
        'Get email statistics and analytics for a mailbox. Shows volume, top senders, daily trends, and read/flagged counts.',
      inputSchema: {
        account: z.string().describe('Account name'),
        period: z
          .enum(['day', 'week', 'month'])
          .default('week')
          .describe('Time period: day, week, or month'),
        mailbox: z.string().default('INBOX').describe('Mailbox path (default: INBOX)'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, period, mailbox }) => {
      const stats = await imapService.getEmailStats(account, mailbox, period);

      return {
        content: [
          {
            type: 'text' as const,
            // Top-sender names and addresses come from mail headers anyone can write.
            text: delimitUntrusted(JSON.stringify(stats, null, 2)),
          },
        ],
      };
    },
  );
}
