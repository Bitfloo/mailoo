import { rm } from 'node:fs/promises';
import type { MockInstance } from 'vitest';
import { mcpLog } from '../logging.js';
import { hooksConfig, meta, mockImap } from '../test-support/hooks-harness.js';
import type { Email, EmailMeta, HookRule, HooksConfig } from '../types/index.js';
import { isCalendarProcessed } from '../utils/calendar-state.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import type { SavedAttachment } from './local-calendar.service.js';
import LocalCalendarService from './local-calendar.service.js';

const { stateHome, previousStateHome } = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previous = process.env.XDG_STATE_HOME;
  const dir = await mkdtemp(join(tmpdir(), 'mailoo-hooks-state-'));
  // Set before config/xdg loads: calendar-state must never write the real ~/.local/state.
  process.env.XDG_STATE_HOME = dir;
  return { stateHome: dir, previousStateHome: previous };
});

afterAll(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  await rm(stateHome, { recursive: true, force: true });
});

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

/** Outlook global object id, folded at 75 octets the way Exchange sends the UID line. */
const INVITE_UID =
  '040000008200E00074C5B7101A82E00800000000F0B6A4B2C8D9DA01000000000000000010000000A1B2C3D4E5F60718293A4B5C6D7E8F90';

/** A text/calendar REQUEST part as Exchange sends it with a meeting invitation. */
const INVITE_ICS = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'ORGANIZER;CN=Alice:mailto:alice@example.com',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=me@exampl',
  ' e.com:mailto:me@example.com',
  'SUMMARY;LANGUAGE=en-US:Planning sync',
  'DTSTART:20261005T080000Z',
  'DTEND:20261005T083000Z',
  `UID:${INVITE_UID.slice(0, 71)}`,
  ` ${INVITE_UID.slice(71)}`,
  'SEQUENCE:0',
  'DTSTAMP:20260921T070000Z',
  'LOCATION;LANGUAGE=en-US:Room 4',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

describe('HooksService calendar auto-add state', () => {
  let hooks: HooksService | undefined;
  let addEvent: MockInstance<LocalCalendarService['addEvent']>;

  const inviteRule: HookRule = {
    name: 'invites',
    match: { from: 'alice@example.com' },
    actions: { addToCalendar: true },
  };

  /** Same fields ImapService.getEmail returns for a plain-text invitation. */
  function invitation(id: string): Email {
    return {
      ...meta({ id, subject: 'Planning sync', messageId: `<plan-${id}@example.com>` }),
      bodyText: 'Join us Monday at 10:00. https://meet.example.com/abc-defg-hij',
      messageId: `<plan-${id}@example.com>`,
      attachments: [],
      headers: {},
    };
  }

  function calendarImap(email: Email | Error) {
    return {
      ...mockImap(),
      getEmail:
        email instanceof Error
          ? vi.fn().mockRejectedValue(email)
          : vi.fn().mockResolvedValue(email),
      getCalendarParts: vi.fn().mockResolvedValue([]),
      saveEmailAttachments: vi.fn().mockResolvedValue([]),
    };
  }

  /** Awaits flushBatch directly: the batch timer gives no promise to await before the state write. */
  async function runBatch(service: HooksService, emails: EmailMeta[]): Promise<void> {
    eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails });
    await (service as unknown as { flushBatch: () => Promise<void> }).flushBatch();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Never reach osascript or xdg-open: these tests must not touch a real calendar.
    addEvent = vi
      .spyOn(LocalCalendarService.prototype, 'addEvent')
      .mockResolvedValue({ status: 'added', message: 'added' });
  });

  afterEach(() => {
    hooks?.stop();
    hooks = undefined;
    vi.restoreAllMocks();
  });

  it('should leave the email unprocessed when fetching it for the calendar fails', async () => {
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
      calendarImap(new Error('IMAP connection lost')) as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await runBatch(hooks, [meta({ id: '101' })]);

    await expect(isCalendarProcessed('personal', '101')).resolves.toBe(false);
  });

  it.each([
    ['added', true, '110'],
    ['duplicate', true, '111'],
    ['cancelled', true, '112'],
    ['timed_out', false, '113'],
    ['no_display', false, '114'],
  ] as const)(
    'when a static-rule add reports %s, should mark it processed: %s',
    async (status, marked, id) => {
      addEvent.mockResolvedValue({ status, message: status });
      hooks = new HooksService(
        hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
        calendarImap(invitation(id)) as unknown as ImapService,
      );
      hooks.start({} as never, { sampling: false });

      await runBatch(hooks, [meta({ id })]);

      await expect(isCalendarProcessed('personal', id)).resolves.toBe(marked);
    },
  );

  it('should leave the email unprocessed when a triage-requested add fails', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'fast',
      content: { type: 'text', text: JSON.stringify([{ add_to_calendar: true }]) },
    });
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, onNewEmail: 'triage' }),
      calendarImap(new Error('IMAP connection lost')) as unknown as ImapService,
    );
    hooks.start({ createMessage } as never, { sampling: true });

    await runBatch(hooks, [meta({ id: '121' })]);

    await expect(isCalendarProcessed('personal', '121')).resolves.toBe(false);
  });

  it('should not add an email to the calendar again once it was processed', async () => {
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
      calendarImap(invitation('130')) as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await runBatch(hooks, [meta({ id: '130' })]);
    await runBatch(hooks, [meta({ id: '130' })]);

    expect(addEvent.mock.calls).toHaveLength(1);
  });

  it('should pass the ICS UID of the invitation to the calendar', async () => {
    const imap = calendarImap(invitation('131'));
    imap.getCalendarParts.mockResolvedValue([INVITE_ICS]);
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
      imap as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await runBatch(hooks, [meta({ id: '131' })]);

    expect(addEvent.mock.calls[0]?.[0].icsUid).toBe(INVITE_UID);
  });

  /** Runs one static-rule batch for `email` and returns the arguments the calendar add got. */
  async function addArgs(
    email: Email,
    opts: { config?: Partial<HooksConfig>; ics?: string[]; saved?: SavedAttachment[] } = {},
  ) {
    const imap = calendarImap(email);
    imap.getCalendarParts.mockResolvedValue(opts.ics ?? []);
    imap.saveEmailAttachments.mockResolvedValue(opts.saved ?? []);
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule], ...opts.config }),
      imap as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await runBatch(hooks, [meta({ id: email.id })]);

    return addEvent.mock.calls[0];
  }

  it.each([
    [undefined, true, '150'],
    [true, true, '151'],
    [false, false, '152'],
  ] as const)(
    'with calendar_confirm %s, should pass confirm %s to the calendar',
    async (calendarConfirm, confirm, id) => {
      const args = await addArgs(invitation(id), { config: { calendarConfirm } });
      expect(args?.[2]).toEqual({ confirm });
    },
  );

  it("should pass the invitation's start, end and location to the calendar", async () => {
    const args = await addArgs(invitation('153'), { ics: [INVITE_ICS] });
    expect({ start: args?.[0].start, end: args?.[0].end, location: args?.[0].location }).toEqual({
      start: new Date('2026-10-05T08:00:00Z'),
      end: new Date('2026-10-05T08:30:00Z'),
      location: 'Room 4',
    });
  });

  it('should end one hour after the mail date when there is no invitation', async () => {
    const args = await addArgs(invitation('154'));
    expect({ start: args?.[0].start, end: args?.[0].end }).toEqual({
      start: new Date('2026-09-21T00:00:00.000Z'),
      end: new Date('2026-09-21T01:00:00.000Z'),
    });
  });

  it('should title the event with the email subject, not the invitation summary', async () => {
    const reply = { ...invitation('155'), subject: 'Re: Q4 "budget" call' };
    const args = await addArgs(reply, { ics: [INVITE_ICS] });
    expect(args?.[0].title).toBe('Re: Q4 "budget" call');
  });

  it('should pass the configured calendar name and alarm minutes', async () => {
    const args = await addArgs(invitation('156'), {
      config: { calendarName: 'Work', calendarAlarmMinutes: 30 },
    });
    expect({ calendar: args?.[1], alarm: args?.[0].alarmMinutes }).toEqual({
      calendar: 'Work',
      alarm: 30,
    });
  });

  it('should pass no calendar name when calendar_name is empty', async () => {
    const args = await addArgs(invitation('157'), { config: { calendarName: '' } });
    expect(args?.[1]).toBeUndefined();
  });

  it('should set a 15 min alarm when calendar_alarm_minutes is unset', async () => {
    const args = await addArgs(invitation('158'));
    expect(args?.[0].alarmMinutes).toBe(15);
  });

  it('should save the attachments and pass them on to the calendar', async () => {
    const agenda = { filename: 'agenda.pdf', mimeType: 'application/pdf', size: 2048 };
    const saved = {
      ...agenda,
      localPath: '/var/mailoo/calendar-attachments/personal-159/agenda.pdf',
      fileUrl: 'file:///var/mailoo/calendar-attachments/personal-159/agenda.pdf',
    };
    const args = await addArgs({ ...invitation('159'), attachments: [agenda] }, { saved: [saved] });
    expect(args?.[0].savedAttachments).toEqual([saved]);
  });

  it.each([
    ['timed_out', 'warning', '140'],
    ['no_display', 'warning', '141'],
    ['added', 'info', '142'],
  ] as const)('should log a calendar add that reports %s at %s', async (status, level, id) => {
    addEvent.mockResolvedValue({ status, message: `Calendar reported ${status}` });
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
      calendarImap(invitation(id)) as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await runBatch(hooks, [meta({ id })]);

    expect(
      vi
        .mocked(mcpLog)
        .mock.calls.filter(([, , message]) => String(message).startsWith('Calendar: ')),
    ).toEqual([[level, 'hooks', `Calendar: Calendar reported ${status}`]]);
  });
});
