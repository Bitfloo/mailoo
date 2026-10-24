/**
 * Clients treat a tool result as success unless isError is set. A handler
 * that throws, a get_emails call that fetches no message, and a failed test
 * notification must all come back as isError text — including after an SDK
 * upgrade that stops wrapping a thrown handler.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import createServer from '../server.js';
import NotifierService from '../services/notifier.service.js';
import { readAuditEntries } from '../test-support/audit-home.js';
import registerAnalyticsTools from './analytics.tool.js';
import { registerCalendarReadTools, registerCalendarWriteTools } from './calendar.tool.js';
import registerEmailsTools from './emails.tool.js';
import { registerSchedulerReadTools, registerSchedulerWriteTools } from './scheduler.tool.js';
import { registerWatcherWriteTools } from './watcher.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

const FAILURE = 'mailbox unavailable';

interface TextToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function isTextToolResult(result: unknown): result is TextToolResult {
  if (typeof result !== 'object' || result === null || !('content' in result)) return false;
  return Array.isArray(result.content);
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<TextToolResult> {
  const client = new Client({ name: 'mailoo-tool-errors', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    if (!isTextToolResult(result)) throw new Error('tool result has no text content');
    return result;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function expectFailure(result: TextToolResult): void {
  expect(result.isError).toBe(true);
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(FAILURE) });
}

const SCHEDULE_ARGS = {
  account: 'work',
  to: ['recipient@example.com'],
  subject: 'Hello',
  body: 'World',
  send_at: 'in 1 hour',
};

// With no account the double throws in resolveAccountName, before schedule() is reached.
function failingSchedulerServer(resolvedAccount?: string): McpServer {
  const server = createServer();
  const failingScheduler = {
    resolveAccountName: () => {
      if (resolvedAccount === undefined) throw new Error(FAILURE);
      return resolvedAccount;
    },
    list: async () => Promise.reject(new Error(FAILURE)),
    schedule: async () => Promise.reject(new Error(FAILURE)),
    cancel: async () => Promise.reject(new Error(FAILURE)),
  } as never;
  registerSchedulerReadTools(server, failingScheduler);
  registerSchedulerWriteTools(server, failingScheduler);
  return server;
}

describe('tool failures return isError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return isError with the message as text when a handler throws', async () => {
    const server = createServer();
    server.registerTool('throwing_probe', { inputSchema: {} }, async () => {
      throw new Error(FAILURE);
    });
    const result = await callTool(server, 'throwing_probe', {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: FAILURE }]);
  });

  it('should return isError when get_emails cannot fetch a message', async () => {
    const server = createServer();
    registerEmailsTools(
      server,
      { getEmail: async () => Promise.reject(new Error(FAILURE)) } as never,
      false,
    );
    const result = await callTool(server, 'get_emails', {
      account: 'personal',
      ids: ['9'],
      mailbox: 'INBOX',
      format: 'text',
    });
    expectFailure(result);
  });

  it('should return isError when test_notification reports failure', async () => {
    vi.spyOn(NotifierService, 'checkPlatformSupport').mockResolvedValue({
      platform: 'test',
      supported: false,
      desktopTool: { name: 'none', available: false },
      soundTool: { name: 'none', available: false },
      issues: [],
      setupInstructions: ['open settings'],
    });
    const server = createServer();
    registerWatcherWriteTools(server, {
      getHooksConfig: () => ({
        onNewEmail: 'notify',
        preset: 'priority-focus',
        autoLabel: false,
        autoFlag: false,
        batchDelay: 5,
        rules: [],
        alerts: {},
      }),
      getNotifier: () => ({
        sendTestNotification: async () => ({ success: false, message: FAILURE }),
      }),
    } as never);
    const result = await callTool(server, 'test_notification', { sound: false });
    expectFailure(result);
  });

  it('should return isError for calendar read and write tools when services throw', async () => {
    const server = createServer();
    const failingImap = {
      getEmail: async () => Promise.reject(new Error(FAILURE)),
    } as never;
    const failingCalendar = {
      extractFromEmail: () => {
        throw new Error(FAILURE);
      },
    } as never;
    const failingLocalCalendar = {
      checkPermissions: async () => Promise.reject(new Error(FAILURE)),
      listCalendars: async () => Promise.reject(new Error(FAILURE)),
      listEvents: async () => Promise.reject(new Error(FAILURE)),
      addEvent: async () => Promise.reject(new Error(FAILURE)),
    } as never;
    const failingReminders = {
      checkPermissions: async () => Promise.reject(new Error(FAILURE)),
      listReminders: async () => Promise.reject(new Error(FAILURE)),
      addReminder: async () => Promise.reject(new Error(FAILURE)),
    } as never;

    registerCalendarReadTools(
      server,
      failingImap,
      failingCalendar,
      failingLocalCalendar,
      failingReminders,
    );
    registerCalendarWriteTools(
      server,
      failingImap,
      failingCalendar,
      failingLocalCalendar,
      failingReminders,
    );

    expectFailure(
      await callTool(server, 'extract_calendar', {
        account: 'work',
        emailId: '1',
        mailbox: 'INBOX',
      }),
    );
    expectFailure(await callTool(server, 'check_calendar_permissions', {}));
    expectFailure(await callTool(server, 'list_calendars', {}));
    expectFailure(await callTool(server, 'list_events', { limit: 10 }));
    expectFailure(await callTool(server, 'list_reminders', { limit: 10 }));
    expectFailure(
      await callTool(server, 'analyze_email_for_scheduling', {
        account: 'work',
        emailId: '1',
        mailbox: 'INBOX',
      }),
    );
    expectFailure(
      await callTool(server, 'add_to_calendar', {
        account: 'work',
        emailId: '1',
        mailbox: 'INBOX',
      }),
    );
    expectFailure(
      await callTool(server, 'create_reminder', {
        account: 'work',
        emailId: '1',
        confirm: true,
      }),
    );
  });

  it('should return isError when get_email_stats fails in analytics tool', async () => {
    const server = createServer();
    registerAnalyticsTools(server, {
      getEmailStats: async () => Promise.reject(new Error(FAILURE)),
    } as never);
    const result = await callTool(server, 'get_email_stats', {
      account: 'work',
      mailbox: 'INBOX',
      days: 7,
    });
    expectFailure(result);
  });

  it.each([
    ['list_scheduled', { status: 'all' }],
    ['schedule_email', SCHEDULE_ARGS],
    ['cancel_scheduled', { schedule_id: 'sched-1' }],
  ])('should return isError for %s when the scheduler service throws', async (name, args) => {
    expectFailure(await callTool(failingSchedulerServer(), name, args));
  });

  it('should return isError for schedule_email when schedule rejects for a resolved account', async () => {
    expectFailure(await callTool(failingSchedulerServer('work'), 'schedule_email', SCHEDULE_ARGS));
  });
});

describe('tool failures are audited', () => {
  it('should write one audit entry per failed schedule_email and cancel_scheduled call', async () => {
    const server = failingSchedulerServer();
    const before = (await readAuditEntries(auditHome)).length;
    await callTool(server, 'schedule_email', SCHEDULE_ARGS);
    await callTool(server, 'cancel_scheduled', { schedule_id: 'sched-1' });
    // A pin set after the imports sends these entries to the inherited data home instead.
    expect((await readAuditEntries(auditHome)).slice(before).map((entry) => entry.tool)).toEqual([
      'schedule_email',
      'cancel_scheduled',
    ]);
  });

  it('should audit a schedule_email whose schedule call rejects as an error with its message', async () => {
    const server = failingSchedulerServer('work-resolved');
    const before = (await readAuditEntries(auditHome)).length;
    await callTool(server, 'schedule_email', SCHEDULE_ARGS);
    expect((await readAuditEntries(auditHome)).slice(before)).toEqual([
      {
        ts: expect.any(String),
        tool: 'schedule_email',
        account: 'work-resolved',
        params: { to: ['recipient@example.com'], subject: 'Hello', send_at: 'in 1 hour' },
        result: 'error',
        error: FAILURE,
      },
    ]);
  });
});
