const { osascriptImpl } = vi.hoisted(() => ({
  osascriptImpl: vi.fn(
    async (
      _file: string,
      _args: string[],
      _options: { timeout?: number },
    ): Promise<{ stdout: string; stderr: string }> => ({ stdout: '[]', stderr: '' }),
  ),
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => undefined, {
    [Symbol.for('nodejs.util.promisify.custom')]: osascriptImpl,
  }),
}));

import { delimitUntrusted } from '../safety/untrusted-content.js';
import { dateSetBy, dialogLinesOf, literalAfter } from '../test-support/applescript.js';
import onDarwin from '../test-support/platform.js';
import type { LocalCalendarEventInput } from './local-calendar.service.js';
import LocalCalendarService, { ADD_EVENT_TIMEOUT_MS } from './local-calendar.service.js';
import { CONFIRM_DIALOG_WAIT_S } from './osascript.js';

beforeEach(() => {
  osascriptImpl.mockReset();
  osascriptImpl.mockResolvedValue({ stdout: '[]', stderr: '' });
});

describe('addEvent script', () => {
  const offsite = {
    title: 'Q3 "board" \\ offsite',
    start: new Date(2026, 9, 5, 9, 0, 0),
    end: new Date(2026, 9, 5, 17, 0, 0),
    location: 'Hall "B", C:\\maps',
    notes: 'Agenda:\n"budget" \\ hiring',
  };

  async function addScript(
    event: LocalCalendarEventInput = offsite,
    calendarName = 'Work',
  ): Promise<string> {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"added"}', stderr: '' });
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(event, calendarName, {
        confirm: false,
        skipDuplicateCheck: true,
      }),
    );
    return osascriptImpl.mock.calls[0]?.[1][1] ?? '';
  }

  it('should keep a quoted title, location and notes intact in the add script', async () => {
    const script = await addScript();
    expect({
      title: literalAfter(script, 'set eventTitle to '),
      location: literalAfter(script, '{location:'),
      notes: literalAfter(script, '{description:'),
    }).toEqual({ title: offsite.title, location: offsite.location, notes: offsite.notes });
  });

  it('should keep a quoted calendar name and URL intact in the add script', async () => {
    const calendar = 'Board "Q3" \\ shared';
    const url = 'https://meet.example.com/j/8812?pwd=a"b\\c';
    const script = await addScript({ ...offsite, url }, calendar);
    expect({
      calendar: literalAfter(script, 'first calendar whose name is '),
      url: literalAfter(script, '{url:'),
    }).toEqual({ calendar, url });
  });

  it('should build the added event id and calendar name through jsonString', async () => {
    const script = await addScript();
    expect(
      ['eventId', 'finalCalName'].filter((field) => !script.includes(`my jsonString(${field})`)),
    ).toEqual([]);
  });

  it('should give the add script a 90 s budget', async () => {
    // The confirm dialog alone may wait CONFIRM_DIALOG_WAIT_S; a shorter budget would cut off
    // a confirmed add.
    await addScript();
    expect(osascriptImpl.mock.calls[0]?.[2].timeout).toBe(90_000);
  });

  it('should give the add script more time than the confirm dialog waits', () => {
    expect(ADD_EVENT_TIMEOUT_MS).toBeGreaterThan(CONFIRM_DIALOG_WAIT_S * 1000);
  });

  it('should set the alarm 900 s before the event by default', async () => {
    const script = await addScript();
    expect(/trigger interval:(-?\d+)/.exec(script)?.[1]).toBe('-900');
  });

  it('should set no alarm when alarmMinutes is 0', async () => {
    const script = await addScript({ ...offsite, alarmMinutes: 0 });
    expect(script.includes('display alarm')).toBe(false);
  });
});

describe('addEvent confirm dialog', () => {
  /** A meeting invitation subject and room as mail carries them. */
  const review = {
    title: 'Q3 "board" \\ review',
    start: new Date(2026, 9, 5, 9, 0, 0),
    end: new Date(2026, 9, 5, 10, 0, 0),
    location: 'Room "Oak"',
  };

  async function dialogFor(event: LocalCalendarEventInput): Promise<string[]> {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"cancelled"}', stderr: '' });
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(event, 'Work', { skipDuplicateCheck: true }),
    );
    return dialogLinesOf(osascriptImpl.mock.calls.at(-1)?.[1][1] ?? '');
  }

  it('should give up the dialog after CONFIRM_DIALOG_WAIT_S seconds', async () => {
    await dialogFor(review);
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect(/giving up after (\d+)/.exec(script)?.[1]).toBe(String(CONFIRM_DIALOG_WAIT_S));
  });

  it('should show a quoted title and location in the dialog as the mail wrote them', async () => {
    const lines = await dialogFor(review);
    expect([lines[0], lines[2]]).toEqual([
      '\u{1F4C5} Q3 "board" \\ review',
      '\u{1F4CD} Room "Oak"',
    ]);
  });

  it('should end the dialog with the calendar name and alarm minutes', async () => {
    const lines = await dialogFor(review);
    expect(lines.at(-1)).toBe('\u{1F4C6} Work \u00B7 \u23F0 15 min before');
  });

  it('should show the event start and end in the dialog, not the script that reads them', async () => {
    const lines = await dialogFor(review);
    expect(lines[1]).toBe('\u{1F550} <eventStart> \u2013 <eventEnd>');
  });

  it('should name the default calendar in the dialog when no calendar is given', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"cancelled"}', stderr: '' });
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(review, undefined, { skipDuplicateCheck: true }),
    );
    const lines = dialogLinesOf(osascriptImpl.mock.calls[0]?.[1][1] ?? '');
    expect(lines.at(-1)).toBe('\u{1F4C6} Default Calendar \u00b7 \u23f0 15 min before');
  });

  it('should count attendees and attachments, saved and pending, in the dialog', async () => {
    const agenda = {
      filename: 'agenda.pdf',
      localPath: '/var/mailoo/agenda.pdf',
      fileUrl: 'file:///var/mailoo/agenda.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    };
    const slides = { filename: 'slides.key', mimeType: 'application/x-iwork-keynote', size: 9000 };
    const one = await dialogFor({ ...review, attendeeCount: 1, savedAttachments: [agenda] });
    const many = await dialogFor({
      ...review,
      attendeeCount: 3,
      savedAttachments: [agenda],
      pendingAttachments: [slides],
    });
    expect({ one: one.slice(3, 5), many: many.slice(3, 5) }).toEqual({
      one: ['\u{1F465} 1 attendee', '\u{1F4CE} 1 attachment saved locally'],
      many: ['\u{1F465} 3 attendees', '\u{1F4CE} 2 attachments saved locally'],
    });
  });

  it('should label the meeting link by its label, then its provider, then its domain', async () => {
    const url = 'https://meet.example.com/j/8812?pwd=a';
    const labels = [
      await dialogFor({ ...review, url, urlLabel: 'Zoom', conferenceProvider: 'Teams' }),
      await dialogFor({ ...review, url, conferenceProvider: 'Teams' }),
      await dialogFor({ ...review, url }),
    ].map((lines) => lines[3]);
    expect(labels).toEqual(['\u{1F3A5} Zoom', '\u{1F3A5} Teams', '\u{1F3A5} meet.example.com']);
  });

  it('should show the dial-in and the meeting ID with its PIN', async () => {
    const lines = await dialogFor({
      ...review,
      dialIn: '+1 555 0100',
      meetingId: '881 2345',
      passcode: '9921',
    });
    expect(lines.slice(3, 5)).toEqual([
      '\u{1F4DE} +1 555 0100',
      '\u{1F511} ID: 881 2345 \u00b7 PIN: 9921',
    ]);
  });
});

describe('addEvent dates', () => {
  async function addScriptFor(start: Date): Promise<string> {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"added"}', stderr: '' });
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(
        { title: 'Budget review', start, end: new Date(start.getTime() + 3_600_000) },
        'Work',
        { confirm: false, skipDuplicateCheck: true },
      ),
    );
    return osascriptImpl.mock.calls[0]?.[1][1] ?? '';
  }

  it('should start on 28 February when the script runs on 31 January', async () => {
    // Setting month 2 on 31 January lands on 3 March before the day is set.
    const start = new Date(2026, 1, 28, 9, 30, 0);
    const script = await addScriptFor(start);
    expect(dateSetBy(script, 'eventStart', new Date(2026, 0, 31, 12, 0, 0))).toEqual(start);
  });

  it('should start on 31 October when the script runs on 30 September', async () => {
    // Setting day 31 in September lands on 1 October before the month is set.
    const start = new Date(2026, 9, 31, 9, 30, 0);
    const script = await addScriptFor(start);
    expect(dateSetBy(script, 'eventStart', new Date(2026, 8, 30, 12, 0, 0))).toEqual(start);
  });
});

describe('addEvent failures', () => {
  /** Adds an event while osascript exits non-zero with `stderr`, as execFile rejects. */
  async function addRejectedWith(stderr: string) {
    osascriptImpl.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: osascript -e set eventTitle to "Budget review"'), {
        killed: false,
        code: 1,
        stderr,
      }),
    );
    return onDarwin(async () =>
      new LocalCalendarService().addEvent(
        {
          title: 'Budget review',
          start: new Date(2026, 9, 5, 9, 0, 0),
          end: new Date(2026, 9, 5, 10, 0, 0),
        },
        'Work',
        { confirm: false, skipDuplicateCheck: true },
      ),
    );
  }

  it('should report an add the user cancelled (-128) as cancelled', async () => {
    await expect(
      addRejectedWith('0:312: execution error: User canceled. (-128)\n'),
    ).resolves.toEqual({ status: 'cancelled', message: 'Cancelled by user.' });
  });

  it('should report a failed add as no_display with the reason', async () => {
    await expect(
      addRejectedWith(
        '0:312: execution error: Calendar got an error: AppleEvent timed out. (-1712)\n',
      ),
    ).resolves.toEqual({
      status: 'no_display',
      message:
        'Could not add event: osascript failed: 0:312: execution error: Calendar got an error: AppleEvent timed out. (-1712)',
    });
  });

  it('should report a refused add as no_display with the access-denied message', async () => {
    await expect(
      addRejectedWith(
        '0:312: execution error: Not authorized to send Apple events to Calendar. (-1743)\n',
      ),
    ).resolves.toEqual({
      status: 'no_display',
      message: 'Calendar access denied. Run check_calendar_permissions for setup instructions.',
    });
  });
});

describe('addEvent result', () => {
  async function addReporting(stdout: string) {
    osascriptImpl.mockResolvedValueOnce({ stdout, stderr: '' });
    return onDarwin(async () =>
      new LocalCalendarService().addEvent(
        {
          title: 'Budget review',
          start: new Date(2026, 9, 5, 9, 0, 0),
          end: new Date(2026, 9, 5, 10, 0, 0),
        },
        'Work',
        { skipDuplicateCheck: true },
      ),
    );
  }

  it('should return the status, event id and calendar name the add script reports', async () => {
    // The script falls back to the first calendar, so its name can differ from the one asked for.
    await expect(
      addReporting('{"status":"added","eventId":"E1","calendarName":"Home"}\n'),
    ).resolves.toEqual({
      status: 'added',
      eventId: 'E1',
      calendarName: 'Home',
      message: `✅ Event added: "${delimitUntrusted('Budget review')}" → Home.`,
    });
  });

  it('should report a timed-out dialog as timed_out with the wait in the message', async () => {
    await expect(addReporting('{"status":"timed_out"}\n')).resolves.toEqual({
      status: 'timed_out',
      message: '⏱️ Dialog timed out after 60 s — event was not added. Try again.',
    });
  });
});
