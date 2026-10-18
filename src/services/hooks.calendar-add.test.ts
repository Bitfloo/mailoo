import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { MockInstance } from 'vitest';
import { CALENDAR_ATTACHMENTS_DIR } from '../config/xdg.js';
import { calendarImap, hooksConfig, invitation, meta } from '../test-support/hooks-harness.js';
import type { Email } from '../types/index.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
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
const SAVED_AGENDA = {
  ...AGENDA,
  localPath: '/var/mailoo/calendar-attachments/work-11/agenda.pdf',
  fileUrl: 'file:///var/mailoo/calendar-attachments/work-11/agenda.pdf',
};

describe('HooksService calendar auto-add', () => {
  let hooks: HooksService | undefined;
  let addEvent: MockInstance<LocalCalendarService['addEvent']>;

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

  /** Runs one static-rule batch for `email` in work/Projects; returns the IMAP mock. */
  async function autoAdd(email: Email, setup: (imap: ReturnType<typeof calendarImap>) => void) {
    const imap = calendarImap(email);
    setup(imap);
    hooks = new HooksService(
      hooksConfig({
        batchDelay: 3600,
        rules: [{ name: 'invites', match: { from: 'alice@*' }, actions: { addToCalendar: true } }],
      }),
      imap as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });
    eventBus.emit('email:new', {
      account: 'work',
      mailbox: 'Projects',
      emails: [meta({ id: email.id })],
    });
    await (hooks as unknown as { flushBatch: () => Promise<void> }).flushBatch();
    return imap;
  }

  const added = () => addEvent.mock.calls[0]?.[0];
  const details = (notes = '') => notes.slice(notes.indexOf('\u{1F4DD}'));

  it("should fetch the mail, its calendar parts and its attachments with the mail's account, mailbox and id", async () => {
    const imap = await autoAdd({ ...invitation('7'), attachments: [AGENDA] }, () => {});
    expect({
      getEmail: imap.getEmail.mock.calls,
      getCalendarParts: imap.getCalendarParts.mock.calls,
      saveEmailAttachments: imap.saveEmailAttachments.mock.calls,
    }).toEqual({
      getEmail: [['work', '7', 'Projects']],
      getCalendarParts: [['work', 'Projects', '7']],
      saveEmailAttachments: [
        ['work', '7', 'Projects', path.join(CALENDAR_ATTACHMENTS_DIR, 'work-7')],
      ],
    });
  });

  it('should still add the event at the mail date when getCalendarParts rejects', async () => {
    await autoAdd(invitation('8'), (imap) => {
      imap.getCalendarParts.mockRejectedValue(new Error('BODYSTRUCTURE missing'));
    });
    expect({ title: added()?.title, start: added()?.start, end: added()?.end }).toEqual({
      title: 'Planning sync',
      start: new Date('2026-09-21T00:00:00.000Z'),
      end: new Date('2026-09-21T01:00:00.000Z'),
    });
  });

  it.each([
    ['a DTEND only', '13', ['DTEND:20261005T083000Z']],
    ['neither DTSTART nor DTEND', '14', []],
  ])('should add the event at the mail date when the invitation has %s', async (_, id, dates) => {
    const ics = [
      'BEGIN:VCALENDAR',
      'METHOD:REQUEST',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      `UID:undated-${id}@example.com`,
      ...dates,
      'SUMMARY:Planning sync',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    await autoAdd(invitation(id), (imap) => imap.getCalendarParts.mockResolvedValue([ics]));
    expect({ start: added()?.start, end: added()?.end }).toEqual({
      start: new Date('2026-09-21T00:00:00.000Z'),
      end: new Date('2026-09-21T01:00:00.000Z'),
    });
  });

  it('should read the conference details and the notes excerpt from the HTML part of an HTML-only mail', async () => {
    const htmlOnly = {
      ...invitation('9'),
      bodyText: undefined,
      bodyHtml: '<p>Join Zoom Meeting</p><p>Meeting ID: 881 2345 678</p><p>Passcode: 9921</p>',
    };
    await autoAdd(htmlOnly, () => {});
    expect({
      meetingId: added()?.meetingId,
      passcode: added()?.passcode,
      details: details(added()?.notes),
    }).toEqual({
      meetingId: '881 2345 678',
      passcode: '9921',
      details:
        '\u{1F4DD} Details:\nJoin Zoom Meeting\n\nMeeting ID: 881 2345 678\n\nPasscode: 9921',
    });
  });

  it('should find a meeting link that only the text part holds', async () => {
    const email = { ...invitation('10'), bodyText: ZOOM_TEXT, bodyHtml: '<p>Agenda attached</p>' };
    await autoAdd(email, () => {});
    expect({ url: added()?.url, urlLabel: added()?.urlLabel }).toEqual({
      url: 'https://example.zoom.us/j/8812345678?pwd=abc',
      urlLabel: 'Zoom',
    });
  });

  it('should label the link in the notes with the service the link names', async () => {
    // Whereby has a link pattern but no provider pattern, so only the link can name it.
    const email = { ...invitation('12'), bodyText: 'Join: https://whereby.com/team-standup' };
    await autoAdd(email, () => {});
    const notes = added()?.notes ?? '';
    expect(notes.split('\n').find((line) => line.startsWith('\u{1F3A5}'))).toBe(
      '\u{1F3A5} Whereby: https://whereby.com/team-standup',
    );
  });

  it('should put the origin, link, dial-in, meeting ID, passcode, excerpt and saved attachments in the notes', async () => {
    // toLocaleString depends on the host locale and zone; this pins it to the ISO form.
    vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function iso(this: Date) {
      return this.toISOString();
    });
    await autoAdd({ ...invitation('11'), bodyText: ZOOM_TEXT, attachments: [AGENDA] }, (imap) => {
      imap.saveEmailAttachments.mockResolvedValue([SAVED_AGENDA]);
    });
    expect(added()?.notes).toBe(
      [
        '\u{1F4E7} From: Alice <alice@example.com>',
        '\u{1F4E7} Subject: Planning sync',
        '\u{1F4E7} Received: 2026-09-21T00:00:00.000Z',
        '',
        '\u{1F3A5} Zoom: https://example.zoom.us/j/8812345678?pwd=abc',
        '\u{1F4DE} Dial-in: +1 555 010 0199',
        '\u{1F511} Meeting ID: 881 2345 678 · Passcode: 9921',
        '',
        `\u{1F4DD} Details:\n${ZOOM_TEXT}`,
        '',
        '\u{1F4CE} Attachments:',
        `  • agenda.pdf (2 KB) → ${SAVED_AGENDA.fileUrl}`,
      ].join('\n'),
    );
  });
});
