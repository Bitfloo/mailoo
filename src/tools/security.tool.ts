/**
 * MCP tool: get_email_security — read-only sender authentication signals.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

export default function registerSecurityTools(server: McpServer, imapService: ImapService): void {
  server.tool(
    'get_email_security',
    'Read-only SPF/DKIM/DMARC and From/Reply-To/Return-Path domain signals for an email. ' +
      'Does not change flags. Does not return unsubscribe or tracking URLs.',
    {
      account: z.string().describe('Account name from list_accounts'),
      emailId: z.string().describe('Email ID (UID) from list_emails or get_email'),
      mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, emailId, mailbox }) => {
      try {
        const signals = await imapService.getEmailSecurity(account, emailId, mailbox);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(signals, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to read sender authentication: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
