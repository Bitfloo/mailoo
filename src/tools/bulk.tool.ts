/**
 * MCP tool: bulk_action — batch operations on multiple emails.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { sanitizeMailboxName } from '../safety/validation.js';
import type ImapService from '../services/imap.service.js';
import type { BulkResult } from '../types/index.js';
import {
  accountParam,
  dryRunParam,
  idArraySchema,
  normalizeNumericIds,
  structuredToolResult,
} from './schema-helpers.js';

export default function registerBulkTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'bulk_action',
    {
      title: 'Run Bulk Action',
      description:
        'Batch operation on multiple emails by UID list. Supports mark_read, mark_unread, flag, unflag, move, and delete. delete moves the messages to Trash. Max 100 IDs per call. Returns success/failure counts.',
      inputSchema: {
        account: accountParam,
        mailbox: z.string().default('INBOX').describe('Source mailbox containing the emails'),
        action: z
          .enum(['mark_read', 'mark_unread', 'flag', 'unflag', 'move', 'delete'])
          .describe('Bulk action to perform'),
        ids: idArraySchema(
          100,
          'Array of email UIDs (max 100). Get UIDs from list_emails or search_emails.',
        ),
        destination: z
          .string()
          .optional()
          .describe("Destination mailbox — required when action is 'move'"),
        dryRun: dryRunParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, mailbox, action, ids, destination, dryRun }) => {
      const accountInput = account ?? '';
      let numericIds: number[] = [];
      try {
        numericIds = normalizeNumericIds(ids);

        if (action === 'move' && !destination) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Destination mailbox is required for "move" action.`,
              },
            ],
          };
        }

        if (dryRun) {
          sanitizeMailboxName(mailbox);
          if (action === 'move' && destination) {
            sanitizeMailboxName(destination);
          }
          const resolvedAccount =
            typeof imapService.resolveAccountName === 'function'
              ? imapService.resolveAccountName(account)
              : accountInput;
          return structuredToolResult(
            `[DRY RUN] Would perform bulk "${action}" on ${numericIds.length} email(s) in "${mailbox}"${destination ? ` -> "${destination}"` : ''} on account "${resolvedAccount}".`,
            {
              action: 'bulk_action',
              bulkAction: action,
              account: resolvedAccount,
              mailbox,
              destination,
              count: numericIds.length,
            },
            true,
          );
        }

        let result: BulkResult;
        if (action === 'move') {
          result = await imapService.bulkMove(
            accountInput,
            numericIds,
            mailbox,
            destination as string,
          );
        } else if (action === 'delete') {
          result = await imapService.bulkDelete(accountInput, numericIds, mailbox);
        } else {
          result = await imapService.bulkSetFlags(accountInput, numericIds, mailbox, action);
        }

        await audit.log(
          'bulk_action',
          accountInput,
          {
            mailbox,
            action,
            ids: numericIds.length,
            destination,
          },
          'ok',
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'bulk_action',
          accountInput,
          { mailbox, action, ids: numericIds.length || ids.length },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Bulk action failed: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
