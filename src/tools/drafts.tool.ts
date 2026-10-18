/**
 * MCP tools: save_draft, send_draft
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { recipientEmail } from '../safety/validation.js';

import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';
import {
  accountParam,
  draftIdInputFields,
  dryRunParam,
  resolveDraftId,
  structuredToolResult,
} from './schema-helpers.js';

export default function registerDraftTools(
  server: McpServer,
  imapService: ImapService,
  smtpService: SmtpService,
): void {
  // ---------------------------------------------------------------------------
  // save_draft
  // ---------------------------------------------------------------------------
  server.registerTool(
    'save_draft',
    {
      title: 'Save Draft',
      description:
        'Save an email draft to the Drafts folder. Compose over time, then use send_draft to send it. Use list_emails with the Drafts mailbox to see saved drafts.',
      inputSchema: {
        account: accountParam,
        to: z
          .array(recipientEmail)
          .default([])
          .describe('Recipient email addresses (can be empty for drafts)'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body content'),
        cc: z.array(recipientEmail).optional().describe('CC recipients'),
        bcc: z.array(recipientEmail).optional().describe('BCC recipients'),
        html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
        in_reply_to: z.string().optional().describe('Message-ID for threading (from get_email)'),
        attachments: z
          .array(
            z.object({
              filename: z.string().optional(),
              path: z.string().optional(),
              base64: z.string().optional(),
              contentType: z.string().optional(),
            }),
          )
          .optional()
          .describe('Draft attachments (path or base64)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account, to, subject, body, cc, bcc, html, in_reply_to: inReplyTo, attachments }) => {
      const accountInput = account ?? '';
      try {
        const result = await imapService.saveDraft(accountInput, {
          to,
          subject,
          body,
          cc,
          bcc,
          html,
          inReplyTo,
          attachments,
        });

        await audit.log('save_draft', accountInput, { to, subject }, 'ok');

        return {
          content: [
            {
              type: 'text' as const,
              text: `📝 Draft saved (ID: ${result.id}, folder: ${result.mailbox}).`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('save_draft', accountInput, { to, subject }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to save draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // send_draft
  // ---------------------------------------------------------------------------
  server.registerTool(
    'send_draft',
    {
      title: 'Send Draft',
      description:
        'Send an existing draft email and remove it from Drafts. The draft is fetched, sent via SMTP, then deleted. Use list_emails with the Drafts mailbox to find draft IDs.',
      inputSchema: {
        account: accountParam,
        ...draftIdInputFields('Draft email UID (from list_emails on Drafts mailbox)'),
        mailbox: z.string().optional().describe('Drafts folder path (auto-detected if omitted)'),
        dryRun: dryRunParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const accountInput = params.account ?? '';
      let id: number | string = params.id ?? params.emailId ?? params.email_id ?? '';
      const { mailbox } = params;
      try {
        const resolvedId = resolveDraftId(params);
        id = resolvedId;
        if (params.dryRun) {
          const resolvedAccount =
            typeof smtpService.resolveAccountName === 'function'
              ? smtpService.resolveAccountName(params.account)
              : accountInput;
          const folder = mailbox ? `"${mailbox}"` : 'the Drafts folder';
          return structuredToolResult(
            `[DRY RUN] Would send draft ${resolvedId} from ${folder} on account "${resolvedAccount}" and remove it from Drafts.`,
            { action: 'send_draft', account: resolvedAccount, id: resolvedId, mailbox },
            true,
          );
        }
        const result = await smtpService.sendDraft(accountInput, resolvedId, mailbox);

        await audit.log('send_draft', accountInput, { id: resolvedId, mailbox }, 'ok');

        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Draft sent (Message-ID: ${result.messageId}). ${
                result.draftDeleted === false
                  ? 'Removing the draft failed, so it is still in Drafts: delete it instead of sending it again.'
                  : 'Draft removed from folder.'
              }`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('send_draft', accountInput, { id, mailbox }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send draft: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
