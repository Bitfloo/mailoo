/**
 * MCP tools: create_mailbox, rename_mailbox, delete_mailbox
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { sanitizeMailboxName } from '../safety/validation.js';

import type ImapService from '../services/imap.service.js';
import { accountParam, dryRunParam, structuredToolResult } from './schema-helpers.js';

export default function registerFolderTools(server: McpServer, imapService: ImapService): void {
  // ---------------------------------------------------------------------------
  // create_mailbox
  // ---------------------------------------------------------------------------
  server.registerTool(
    'create_mailbox',
    {
      title: 'Create Mailbox',
      description:
        "Create a new mailbox (folder). Use '/' as separator for nested folders (e.g., 'Work/Projects'). Use list_mailboxes to see existing folders.",
      inputSchema: {
        account: accountParam,
        path: z
          .string()
          .min(1)
          .describe("Folder path to create (e.g., 'Archive/2026' or 'Projects')"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, path: folderPath }) => {
      const accountInput = account ?? '';
      try {
        await imapService.createMailbox(accountInput, folderPath);
        await audit.log('create_mailbox', accountInput, { path: folderPath }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `📁 Mailbox "${folderPath}" created.`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('create_mailbox', accountInput, { path: folderPath }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to create mailbox: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // rename_mailbox
  // ---------------------------------------------------------------------------
  server.registerTool(
    'rename_mailbox',
    {
      title: 'Rename Mailbox',
      description:
        'Rename an existing mailbox (folder). Use list_mailboxes to see current folder paths.',
      inputSchema: {
        account: accountParam,
        path: z.string().min(1).describe('Current folder path'),
        new_path: z.string().min(1).describe('New folder path'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, path: folderPath, new_path: newPath }) => {
      const accountInput = account ?? '';
      try {
        await imapService.renameMailbox(accountInput, folderPath, newPath);
        await audit.log(
          'rename_mailbox',
          accountInput,
          { path: folderPath, new_path: newPath },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `📁 Mailbox renamed from "${folderPath}" to "${newPath}".`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'rename_mailbox',
          accountInput,
          { path: folderPath, new_path: newPath },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to rename mailbox: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // delete_mailbox
  // ---------------------------------------------------------------------------
  server.registerTool(
    'delete_mailbox',
    {
      title: 'Delete Mailbox',
      description:
        '⚠️ DESTRUCTIVE: Permanently delete a mailbox and ALL its contents. This cannot be undone. Use list_mailboxes to verify the folder path.',
      inputSchema: {
        account: accountParam,
        path: z
          .string()
          .min(1)
          .describe('Folder path to delete (⚠️ all emails inside will be lost)'),
        dryRun: dryRunParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, path: folderPath, dryRun }) => {
      const accountInput = account ?? '';
      try {
        if (dryRun) {
          const cleanPath = sanitizeMailboxName(folderPath);
          const resolvedAccount =
            typeof imapService.resolveAccountName === 'function'
              ? imapService.resolveAccountName(account)
              : accountInput;
          return structuredToolResult(
            `[DRY RUN] Would permanently delete mailbox "${cleanPath}" on account "${resolvedAccount}".`,
            {
              action: 'delete_mailbox',
              account: resolvedAccount,
              path: cleanPath,
            },
            true,
          );
        }
        await imapService.deleteMailbox(accountInput, folderPath);
        await audit.log('delete_mailbox', accountInput, { path: folderPath }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `⚠️ Mailbox "${folderPath}" permanently deleted.`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('delete_mailbox', accountInput, { path: folderPath }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to delete mailbox: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
