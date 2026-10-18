/**
 * MCP tools: send_email, reply_email, forward_email
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { recipientEmail, validateInputLength } from '../safety/validation.js';

import type SmtpService from '../services/smtp.service.js';
import {
  accountParam,
  dryRunParam,
  emailIdInputFields,
  resolveEmailId,
  structuredToolResult,
} from './schema-helpers.js';

const outgoingAttachment = z
  .object({
    filename: z.string().optional().describe('Attachment filename'),
    path: z.string().optional().describe('Local file path'),
    base64: z.string().optional().describe('Inline base64 content'),
    contentType: z.string().optional().describe('MIME type'),
    emailId: z.string().optional().describe('Copy this attachment from another message (UID)'),
    mailbox: z.string().optional().describe('Mailbox of emailId (default INBOX)'),
  })
  .refine((a) => [a.path, a.base64, a.emailId && a.filename].some(Boolean), {
    message: 'Each attachment needs path, base64, or emailId+filename',
  });

export default function registerSendTools(server: McpServer, smtpService: SmtpService): void {
  // ---------------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'send_email',
    {
      title: 'Send Email',
      description:
        'Send a new email. Supports plain text or HTML body, CC, BCC, and attachments. ' +
        'Optional messageId lets a retried call reuse the same Message-ID.',
      inputSchema: {
        account: accountParam,
        to: z.array(recipientEmail).min(1).describe('Recipient email addresses'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Email body content'),
        cc: z.array(recipientEmail).optional().describe('CC recipients'),
        bcc: z.array(recipientEmail).optional().describe('BCC recipients'),
        html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
        attachments: z.array(outgoingAttachment).optional().describe('File attachments'),
        messageId: z
          .string()
          .optional()
          .describe('Stable RFC 5322 Message-ID for retries (receivers can dedupe)'),
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
      try {
        validateInputLength(params.subject, 998, 'Subject');
        validateInputLength(params.body, 5_000_000, 'Body');
        if (params.dryRun) {
          const resolvedAccount =
            typeof smtpService.resolveAccountName === 'function'
              ? smtpService.resolveAccountName(params.account)
              : accountInput;
          return structuredToolResult(
            `[DRY RUN] Would send email from account "${resolvedAccount}" to ${params.to.join(', ')} with subject "${params.subject}".`,
            {
              action: 'send_email',
              account: resolvedAccount,
              to: params.to,
              cc: params.cc,
              bcc: params.bcc,
              subject: params.subject,
            },
            true,
          );
        }
        const result = await smtpService.sendEmail(accountInput, params);
        await audit.log(
          'send_email',
          accountInput,
          { to: params.to, subject: params.subject, messageId: params.messageId },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email sent successfully!\nTo: ${params.to.join(', ')}\nSubject: ${params.subject}\nMessage-ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'send_email',
          accountInput,
          { to: params.to, subject: params.subject },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // reply_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'reply_email',
    {
      title: 'Reply to Email',
      description:
        'Reply to an email with proper threading (In-Reply-To & References headers). Use get_email first to read the original.',
      inputSchema: {
        account: accountParam,
        ...emailIdInputFields('Email ID to reply to (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        body: z.string().describe('Reply body content'),
        replyAll: z.boolean().default(false).describe('Reply to all recipients'),
        html: z.boolean().default(false).describe('Send as HTML'),
        messageId: z.string().optional().describe('Stable RFC 5322 Message-ID for retries'),
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
      let emailId = params.emailId ?? params.id ?? params.email_id ?? '';
      try {
        emailId = resolveEmailId(params);
        if (params.dryRun) {
          validateInputLength(params.body, 5_000_000, 'Body');
          const resolvedAccount =
            typeof smtpService.resolveAccountName === 'function'
              ? smtpService.resolveAccountName(params.account)
              : accountInput;
          return structuredToolResult(
            `[DRY RUN] Would reply to email ${emailId} in "${params.mailbox}" on account "${resolvedAccount}" (replyAll=${params.replyAll}).`,
            {
              action: 'reply_email',
              account: resolvedAccount,
              emailId,
              mailbox: params.mailbox,
              replyAll: params.replyAll,
            },
            true,
          );
        }
        const result = await smtpService.replyToEmail(accountInput, {
          ...params,
          emailId,
        });
        await audit.log('reply_email', accountInput, { emailId, mailbox: params.mailbox }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Reply sent successfully!\nMessage-ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'reply_email',
          accountInput,
          { emailId, mailbox: params.mailbox },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to reply: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // forward_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'forward_email',
    {
      title: 'Forward Email',
      description:
        'Forward an email to new recipients with optional additional message. Original email is quoted below. Original attachments are not included.',
      inputSchema: {
        account: accountParam,
        ...emailIdInputFields('Email ID to forward (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        to: z.array(recipientEmail).min(1).describe('Forward to these recipients'),
        body: z.string().optional().describe('Additional message above the forwarded content'),
        cc: z.array(recipientEmail).optional().describe('CC recipients'),
        html: z
          .boolean()
          .default(false)
          .describe('Send the additional message + forwarded quote as HTML (default: plain text)'),
        attachments: z.array(outgoingAttachment).optional().describe('Extra file attachments'),
        messageId: z.string().optional().describe('Stable RFC 5322 Message-ID for retries'),
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
      let emailId = params.emailId ?? params.id ?? params.email_id ?? '';
      try {
        emailId = resolveEmailId(params);
        if (params.dryRun) {
          const resolvedAccount =
            typeof smtpService.resolveAccountName === 'function'
              ? smtpService.resolveAccountName(params.account)
              : accountInput;
          return structuredToolResult(
            `[DRY RUN] Would forward email ${emailId} in "${params.mailbox}" on account "${resolvedAccount}" to ${params.to.join(', ')}.`,
            {
              action: 'forward_email',
              account: resolvedAccount,
              emailId,
              mailbox: params.mailbox,
              to: params.to,
              cc: params.cc,
            },
            true,
          );
        }
        const result = await smtpService.forwardEmail(accountInput, {
          ...params,
          emailId,
        });
        await audit.log('forward_email', accountInput, { to: params.to, emailId }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email forwarded successfully!\nTo: ${params.to.join(', ')}\nMessage-ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('forward_email', accountInput, { to: params.to, emailId }, 'error', errMsg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to forward: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
