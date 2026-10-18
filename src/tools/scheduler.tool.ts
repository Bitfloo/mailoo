/**
 * MCP Tools: schedule_email, list_scheduled, cancel_scheduled
 *
 * Email scheduling tools for "send later" functionality.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { recipientEmail } from '../safety/validation.js';

import type SchedulerService from '../services/scheduler.service.js';
import { SEND_AT_FORMAT } from '../services/scheduler.service.js';
import { accountParam } from './schema-helpers.js';

function registerSchedulerGroup(
  group: 'read' | 'write',
  server: McpServer,
  schedulerService: SchedulerService,
): void {
  if (group === 'write') {
    // ---------------------------------------------------------------------------
    // schedule_email (write)
    // ---------------------------------------------------------------------------

    server.registerTool(
      'schedule_email',
      {
        title: 'Schedule Email',
        description:
          'Schedule an email to be sent at a specific time in the future. The email is queued locally and sent automatically when the time arrives.',
        inputSchema: {
          account: accountParam,
          to: z.array(recipientEmail).min(1).describe('Recipient email addresses'),
          subject: z.string().describe('Email subject'),
          body: z.string().describe('Email body'),
          send_at: z.string().describe(`When to send (${SEND_AT_FORMAT})`),
          cc: z.array(recipientEmail).optional().describe('CC recipients'),
          bcc: z.array(recipientEmail).optional().describe('BCC recipients'),
          html: z.boolean().default(false).describe('Send as HTML (default: false)'),
          in_reply_to: z.string().optional().describe('Message-ID to reply to'),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (params) => {
        let resolvedAccount = params.account ?? '';
        try {
          if (typeof schedulerService.resolveAccountName === 'function') {
            resolvedAccount = schedulerService.resolveAccountName(params.account);
          }
          const scheduled = await schedulerService.schedule(resolvedAccount, {
            to: params.to,
            subject: params.subject,
            body: params.body,
            sendAt: params.send_at,
            cc: params.cc,
            bcc: params.bcc,
            html: params.html,
            inReplyTo: params.in_reply_to,
          });

          const result = {
            schedule_id: scheduled.id,
            send_at: scheduled.sendAt,
            draft_saved: !!scheduled.draftMessageId,
            status: 'scheduled',
          };

          await audit.log('schedule_email', resolvedAccount, params, 'ok');

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
            'schedule_email',
            resolvedAccount,
            { to: params.to, subject: params.subject, send_at: params.send_at },
            'error',
            errMsg,
          );
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to schedule email: ${errMsg}`,
              },
            ],
          };
        }
      },
    );
  }

  if (group === 'read') {
    // ---------------------------------------------------------------------------
    // list_scheduled (read)
    // ---------------------------------------------------------------------------

    server.registerTool(
      'list_scheduled',
      {
        title: 'List Scheduled Emails',
        description: 'List scheduled emails. Shows pending, sent, or all scheduled emails.',
        inputSchema: {
          account: z
            .string()
            .optional()
            .describe('Filter by account name (all accounts if omitted)'),
          status: z
            .enum(['pending', 'sent', 'failed', 'all'])
            .default('pending')
            .describe('Filter by status (default: pending)'),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ account, status }) => {
        try {
          const emails = await schedulerService.list({
            account,
            status,
          });

          const summary = emails.map((e) => ({
            id: e.id,
            account: e.account,
            to: e.to.join(', '),
            subject: e.subject,
            send_at: e.sendAt,
            status: e.status,
            attempts: e.attempts,
            overdue: e.status === 'pending' && new Date(e.sendAt).getTime() < Date.now(),
            last_error: e.lastError,
          }));

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ scheduled_emails: summary, count: summary.length }, null, 2),
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to list scheduled emails: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    );
  }

  if (group === 'write') {
    // ---------------------------------------------------------------------------
    // cancel_scheduled (write)
    // ---------------------------------------------------------------------------

    server.registerTool(
      'cancel_scheduled',
      {
        title: 'Cancel Scheduled Email',
        description:
          'Cancel a scheduled email. Removes it from the queue and moves the associated draft to Trash.',
        inputSchema: {
          schedule_id: z.string().describe('Schedule ID to cancel'),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ schedule_id: scheduleId }) => {
        try {
          const result = await schedulerService.cancel(scheduleId);

          await audit.log('cancel_scheduled', 'system', { scheduleId }, 'ok');

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    cancelled: result.cancelled,
                    draft_deleted: result.draftDeleted,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await audit.log('cancel_scheduled', 'system', { scheduleId }, 'error', errMsg);
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Failed to cancel scheduled email: ${errMsg}`,
              },
            ],
          };
        }
      },
    );
  }
}

export function registerSchedulerReadTools(
  server: McpServer,
  schedulerService: SchedulerService,
): void {
  registerSchedulerGroup('read', server, schedulerService);
}

export function registerSchedulerWriteTools(
  server: McpServer,
  schedulerService: SchedulerService,
): void {
  registerSchedulerGroup('write', server, schedulerService);
}
