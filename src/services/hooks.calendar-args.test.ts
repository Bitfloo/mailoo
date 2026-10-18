import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { MockInstance } from 'vitest';
import { CALENDAR_ATTACHMENTS_DIR } from '../config/xdg.js';
import {
  calendarImap,
  hooksConfig,
  invitation,
  meta,
  runBatch,
} from '../test-support/hooks-harness.js';
import type { Email, HookRule, HooksConfig } from '../types/index.js';
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

/** The text part of a Zoom invitation as Zoom writes it. */
const ZOOM_TEXT = [
  'Alice is inviting you to a scheduled Zoom meeting.',
  '',
  'Join Zoom Meeting',
  'https://example.zoom.us/j/8812345678?pwd=abc',
  '',
  'Meeting ID: 881 2345 678',
  'Passcode: 9921',
  '',
  'Dial by your location',
  '        +1 555 010 0199 US',
].join('\n');

const AGENDA = { filename: 'agenda.pdf', mimeType: 'application/pdf', size: 2048 };

describe('HooksService calendar add arguments', () => {
  let hooks: HooksService | undefined;
  let addEvent: MockInstance<LocalCalendarService['addEvent']>;

  const inviteRule: HookRule = {
    name: 'invites',
    match: { from: 'alice@example.com' },
    actions: { addToCalendar: true },
  };

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

  it('should pass the meeting link and its provider label found in the HTML part', async () => {
    const email = {
      ...invitation('180'),
      bodyText: '',
      bodyHtml:
        '<p><a href="https://example.zoom.us/j/8812345678?pwd=abc">Join Zoom Meeting</a></p>',
    };
    const args = await addArgs(email);
    expect({ url: args?.[0].url, urlLabel: args?.[0].urlLabel }).toEqual({
      url: 'https://example.zoom.us/j/8812345678?pwd=abc',
      urlLabel: 'Zoom',
    });
  });

  it('should pass the dial-in, meeting ID and passcode from the text part', async () => {
    // With both parts present only the text part is read; this HTML part names another meeting.
    const email = {
      ...invitation('181'),
      bodyText: ZOOM_TEXT,
      bodyHtml: '<p>Meeting ID: 999 0000 111</p><p>Passcode: 1234</p>',
    };
    const args = await addArgs(email);
    expect({
      dialIn: args?.[0].dialIn,
      meetingId: args?.[0].meetingId,
      passcode: args?.[0].passcode,
    }).toEqual({ dialIn: '+1 555 010 0199', meetingId: '881 2345 678', passcode: '9921' });
  });

  it('should name the sender by display name and address in the notes', async () => {
    const args = await addArgs(invitation('182'));
    expect(args?.[0].notes?.split('\n')[0]).toBe('\u{1F4E7} From: Alice <alice@example.com>');
  });

  it('should take the notes excerpt from the text part when the mail has both', async () => {
    const args = await addArgs({ ...invitation('183'), bodyHtml: '<p>Agenda in HTML</p>' });
    const notes = args?.[0].notes ?? '';
    expect(notes.slice(notes.indexOf('\u{1F4DD}'))).toBe(
      '\u{1F4DD} Details:\nJoin us Monday at 10:00. https://meet.example.com/abc-defg-hij',
    );
  });

  it('should set no alarm when calendar_alarm_minutes is 0', async () => {
    const args = await addArgs(invitation('184'), { config: { calendarAlarmMinutes: 0 } });
    expect(args?.[0].alarmMinutes).toBe(0);
  });

  it('should not save attachments when the email has none', async () => {
    const saved = { ...AGENDA, localPath: '/tmp/agenda.pdf', fileUrl: 'file:///tmp/agenda.pdf' };
    const args = await addArgs(invitation('185'), { saved: [saved] });
    expect(args?.[0].savedAttachments).toEqual([]);
  });

  it('should save attachments in a folder named after the account and id, unsafe characters replaced', async () => {
    const imap = calendarImap({ ...invitation('8'), attachments: [AGENDA] });
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
      imap as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await runBatch(hooks, [meta({ id: '8' })], 'a/b..');

    expect(imap.saveEmailAttachments.mock.calls[0]?.[3]).toBe(
      path.join(CALENDAR_ATTACHMENTS_DIR, 'a_b__-8'),
    );
  });
});
