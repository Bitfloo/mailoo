/**
 * MCP tools: move_email, delete_email, mark_email
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { parseMessageUid, sanitizeMailboxName } from '../safety/validation.js';
import type ImapService from '../services/imap.service.js';
import { FLAG_ACTIONS } from '../services/imap.service.js';
import {
  accountParam,
  dryRunParam,
  emailIdInputFields,
  resolveEmailId,
  structuredToolResult,
} from './schema-helpers.js';

export default function registerManageTools(server: McpServer, imapService: ImapService): void {
  // ---------------------------------------------------------------------------
  // move_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'move_email',
    {
      title: 'Move Email',
      description:
        'Move an email to a different mailbox folder. ' +
        'The sourceMailbox must be a real folder, not a virtual one like "All Mail". ' +
        'Use find_email_folder first if the email was discovered in a virtual folder.',
      inputSchema: {
        account: accountParam,
        ...emailIdInputFields('Email ID to move (from list_emails)'),
        sourceMailbox: z.string().describe('Current mailbox (e.g., INBOX)'),
        destinationMailbox: z
          .string()
          .describe('Target mailbox (e.g., Archive). Use list_mailboxes to see options.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const account = params.account ?? '';
      let emailId = params.emailId ?? params.id ?? params.email_id ?? '';
      const { sourceMailbox, destinationMailbox } = params;
      try {
        emailId = resolveEmailId(params);
        const cleanSource = sanitizeMailboxName(sourceMailbox);
        const cleanDest = sanitizeMailboxName(destinationMailbox);
        await imapService.moveEmail(account, emailId, cleanSource, cleanDest);
        await audit.log(
          'move_email',
          account,
          { emailId, sourceMailbox, destinationMailbox },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email moved from "${sourceMailbox}" to "${destinationMailbox}".`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'move_email',
          account,
          { emailId, sourceMailbox, destinationMailbox },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to move email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // delete_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'delete_email',
    {
      title: 'Delete Email',
      description:
        'Delete an email. By default moves to Trash. Set permanent=true for permanent deletion (⚠️ irreversible). ' +
        'The mailbox must be a real folder. Use find_email_folder first if the email was found in a virtual folder.',
      inputSchema: {
        account: accountParam,
        ...emailIdInputFields('Email ID to delete (from list_emails)'),
        mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
        permanent: z.boolean().default(false).describe('⚠️ Permanently delete (skip Trash)'),
        dryRun: dryRunParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const account = params.account ?? '';
      let emailId = params.emailId ?? params.id ?? params.email_id ?? '';
      const { mailbox, permanent, dryRun } = params;
      try {
        emailId = resolveEmailId(params);
        const cleanMailbox = sanitizeMailboxName(mailbox);
        if (dryRun) {
          parseMessageUid(emailId);
          const resolvedAccount =
            typeof imapService.resolveAccountName === 'function'
              ? imapService.resolveAccountName(params.account)
              : account;
          return structuredToolResult(
            `[DRY RUN] Would ${permanent ? 'permanently delete' : 'move to Trash'} email ${emailId} in "${cleanMailbox}" on account "${resolvedAccount}".`,
            {
              action: 'delete_email',
              account: resolvedAccount,
              emailId,
              mailbox: cleanMailbox,
              permanent,
            },
            true,
          );
        }
        await imapService.deleteEmail(account, emailId, cleanMailbox, permanent);
        await audit.log('delete_email', account, { emailId, mailbox, permanent }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: permanent ? `⚠️ Email permanently deleted.` : `🗑️ Email moved to Trash.`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('delete_email', account, { emailId, mailbox, permanent }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to delete email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // mark_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'mark_email',
    {
      title: 'Mark Email',
      description:
        'Change email flags — mark as read/unread, flag/unflag. Idempotent: marking an already-read email as read is a no-op.',
      inputSchema: {
        account: accountParam,
        ...emailIdInputFields('Email ID (UID) from list_emails or search_emails'),
        mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
        action: z
          .enum(FLAG_ACTIONS)
          .describe('Action: read, unread, flag (star), or unflag (unstar)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      const account = params.account ?? '';
      let id = params.id ?? params.emailId ?? params.email_id ?? '';
      const { mailbox, action } = params;
      try {
        id = resolveEmailId(params);
        await imapService.setFlags(account, id, mailbox, action);
        await audit.log('mark_email', account, { id, mailbox, action }, 'ok');
        const labels: Record<string, string> = {
          read: '📖 Marked as read',
          unread: '📩 Marked as unread',
          flag: '⭐ Flagged',
          unflag: '☆ Unflagged',
        };
        return {
          content: [{ type: 'text' as const, text: `${labels[action]}.` }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('mark_email', account, { id, mailbox, action }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to mark email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
