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
import { dateSetBy, literalAfter } from '../test-support/applescript.js';
import onDarwin from '../test-support/platform.js';
import { ADD_EVENT_TIMEOUT_MS } from './local-calendar.macos.js';
import type { LocalCalendarEventInput } from './local-calendar.service.js';
import LocalCalendarService from './local-calendar.service.js';
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

  it('should fall back to the first calendar when the named one is missing', async () => {
    const lines = (await addScript()).split('\n').map((line) => line.trim());
    const named = lines.indexOf('set theCal to first calendar whose name is "Work"');
    expect(lines.slice(named - 1, named + 4)).toEqual([
      'try',
      'set theCal to first calendar whose name is "Work"',
      'on error',
      'set theCal to first calendar',
      'end try',
    ]);
  });

  it('should make the event in that calendar from the title, start and end', async () => {
    const lines = (await addScript()).split('\n').map((line) => line.trim());
    expect(lines).toEqual(
      expect.arrayContaining([
        'set eventProps to {summary:eventTitle, start date:eventStart, end date:eventEnd}',
        'set theEvent to make new event at end of events of theCal with properties eventProps',
      ]),
    );
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

  it.each([
    ['cancelled', '\u{1F6AB} Cancelled \u2014 event was not added to the calendar.'],
    [
      'no_display',
      '\u26A0\uFE0F No display available. Run check_calendar_permissions for setup instructions.',
    ],
  ])('should word a %s reply from the add script', async (status, message) => {
    await expect(addReporting(`{"status":"${status}"}\n`)).resolves.toEqual({ status, message });
  });
});
