import CalendarService from '../services/calendar.service.js';
import type { AddEventResult, AddEventStatus } from '../services/local-calendar.service.js';
import type { AddReminderResult } from '../services/reminders.service.js';
import { readAuditEntries } from '../test-support/audit-home.js';
import type { Email } from '../types/index.js';
import { registerCalendarWriteTools } from './calendar.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
}>;

/** What imapService.getEmail returns for an invitation with no ICS part. */
const EMAIL: Email = {
  id: '42',
  subject: 'Quarterly review',
  from: { name: 'Ada', address: 'ada@example.com' },
  to: [{ address: 'me@example.test' }],
  date: '2026-03-02T09:00:00.000Z',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: false,
  labels: [],
  bodyText: 'Room 4, see you there.',
  bodyHtml: '',
  messageId: '<review-1@example.com>',
  attachments: [],
  headers: {},
};

/** One saved file as imapService.saveEmailAttachments reports it. */
const SAVED_AGENDA = {
  filename: 'agenda.pdf',
  localPath: '/tmp/agenda.pdf',
  fileUrl: 'file:///tmp/agenda.pdf',
  mimeType: 'application/pdf',
  size: 2048,
};

/** Arguments after the SDK has applied the schema defaults. */
const CALENDAR_ARGS = {
  account: 'personal',
  email_id: '42',
  mailbox: 'INBOX',
  calendar_name: 'Work',
  alarm_minutes: 15,
  save_attachments: true,
  confirm: true,
};
const REMINDER_ARGS = {
  account: 'personal',
  email_id: '42',
  mailbox: 'INBOX',
  priority: 'none',
  list_name: 'Errands',
  confirm: true,
};

/** The status messages local-calendar.service and reminders.service return. */
const EVENT_TIMED_OUT =
  '\u23F1\uFE0F Dialog timed out after 60 s \u2014 event was not added. Try again.';
const REMINDER_TIMED_OUT =
  '\u23F1\uFE0F Dialog timed out \u2014 reminder was not added. Try again.';
const ACCESS_DENIED =
  'Calendar access denied. Run check_calendar_permissions for setup instructions.';

interface Fakes {
  email?: Email;
  ics?: string[];
  addEvent?: (event: { start: Date; end: Date }) => Promise<AddEventResult>;
  addReminder?: () => Promise<AddReminderResult>;
}

function captureWriteTools(fakes: Fakes): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => {
      handlers[name] = fn;
    },
  };
  registerCalendarWriteTools(
    server as never,
    {
      getEmail: async () => fakes.email ?? EMAIL,
      getCalendarParts: async () => fakes.ics ?? [],
      saveEmailAttachments: async () => [SAVED_AGENDA],
    } as never,
    new CalendarService(),
    { addEvent: fakes.addEvent } as never,
    { addReminder: fakes.addReminder } as never,
  );
  return handlers;
}

async function lastEntry() {
  return (await readAuditEntries(auditHome)).at(-1);
}

describe('add_to_calendar audit log', () => {
  it.each<AddEventStatus>(['added', 'duplicate', 'cancelled'])(
    'should record the %s dialog result as ok',
    async (status) => {
      const tools = captureWriteTools({ addEvent: async () => ({ status, message: 'done' }) });

      await tools.add_to_calendar(CALENDAR_ARGS);

      expect(await lastEntry()).toEqual({
        ts: expect.any(String),
        tool: 'add_to_calendar',
        account: 'personal',
        params: {
          email_id: '42',
          mailbox: 'INBOX',
          calendar_name: 'Work',
          attachments_saved: 0,
          status,
        },
        result: 'ok',
      });
    },
  );

  it.each<[AddEventStatus, string]>([
    ['timed_out', EVENT_TIMED_OUT],
    ['no_display', ACCESS_DENIED],
  ])('should record the %s dialog result as an error with its message', async (status, message) => {
    const tools = captureWriteTools({ addEvent: async () => ({ status, message }) });

    await tools.add_to_calendar(CALENDAR_ARGS);

    expect(await lastEntry()).toMatchObject({
      params: { status },
      result: 'error',
      error: message,
    });
  });

  it('should count the attachments saved for the event', async () => {
    const tools = captureWriteTools({
      email: {
        ...EMAIL,
        hasAttachments: true,
        attachments: [{ filename: 'agenda.pdf', mimeType: 'application/pdf', size: 2048 }],
      },
      addEvent: async () => ({ status: 'added', message: 'done' }),
    });

    await tools.add_to_calendar(CALENDAR_ARGS);

    expect((await lastEntry())?.params.attachments_saved).toBe(1);
  });

  it('should record a calendar write that throws as an error and report it', async () => {
    const tools = captureWriteTools({
      addEvent: async () => {
        throw new Error('spawn osascript ENOENT');
      },
    });

    expect(await tools.add_to_calendar(CALENDAR_ARGS)).toMatchObject({
      isError: true,
      content: [{ text: 'Failed to add event to calendar: spawn osascript ENOENT' }],
    });
    expect(await lastEntry()).toMatchObject({
      tool: 'add_to_calendar',
      result: 'error',
      error: 'spawn osascript ENOENT',
    });
  });
});

describe('add_to_calendar event dates', () => {
  it.each([
    ['a DTEND only', ['DTEND:20260302T103000Z']],
    ['neither DTSTART nor DTEND', []],
  ])('should add the event at the mail date when the invitation has %s', async (_, dates) => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:undated-1@example.com',
      ...dates,
      'SUMMARY:Quarterly review',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const addEvent = vi.fn().mockResolvedValue({ status: 'added', message: 'done' });
    const tools = captureWriteTools({ ics: [ics], addEvent });

    await tools.add_to_calendar(CALENDAR_ARGS);

    const event = addEvent.mock.calls[0]?.[0];
    expect({ start: event?.start, end: event?.end }).toEqual({
      start: new Date('2026-03-02T09:00:00.000Z'),
      end: new Date('2026-03-02T10:00:00.000Z'),
    });
  });
});

describe('create_reminder audit log', () => {
  it('should record an added reminder under its list', async () => {
    const tools = captureWriteTools({
      addReminder: async () => ({ status: 'added', listName: 'Errands', message: 'done' }),
    });

    await tools.create_reminder(REMINDER_ARGS);

    expect(await lastEntry()).toEqual({
      ts: expect.any(String),
      tool: 'create_reminder',
      account: 'personal',
      params: { email_id: '42', mailbox: 'INBOX', list_name: 'Errands', status: 'added' },
      result: 'ok',
    });
  });

  it('should record a timed-out dialog as an error with its message', async () => {
    const tools = captureWriteTools({
      addReminder: async () => ({ status: 'timed_out', message: REMINDER_TIMED_OUT }),
    });

    await tools.create_reminder(REMINDER_ARGS);

    expect(await lastEntry()).toMatchObject({
      tool: 'create_reminder',
      params: { status: 'timed_out' },
      result: 'error',
      error: REMINDER_TIMED_OUT,
    });
  });
});
