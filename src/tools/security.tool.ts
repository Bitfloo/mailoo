/**
 * MCP tool: get_email_security — read-only sender authentication signals.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { delimitUntrusted } from '../safety/untrusted-content.js';
import type ImapService from '../services/imap.service.js';
import { accountParam, emailIdInputFields, resolveEmailId } from './schema-helpers.js';

export default function registerSecurityTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'get_email_security',
    {
      title: 'Read Email Security',
      description:
        'Read-only SPF/DKIM/DMARC and From/Reply-To/Return-Path domain signals for an email. ' +
        'Does not change flags. Does not return unsubscribe or tracking URLs.',
      inputSchema: {
        account: accountParam,
        ...emailIdInputFields('Email ID (UID) from list_emails or get_email'),
        mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const emailId = resolveEmailId(params);
        const signals = await imapService.getEmailSecurity(
          params.account ?? '',
          emailId,
          params.mailbox,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: delimitUntrusted(JSON.stringify(signals, null, 2)),
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
