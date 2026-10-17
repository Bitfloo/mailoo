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

import { dateSetBy, dialogLinesOf, literalAfter } from '../test-support/applescript.js';
import onDarwin from '../test-support/platform.js';
import type { LocalCalendarEventInput } from './local-calendar.service.js';
import LocalCalendarService from './local-calendar.service.js';

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
    // The confirm dialog alone may wait 60 s; a shorter budget would cut off a confirmed add.
    await addScript();
    expect(osascriptImpl.mock.calls[0]?.[2].timeout).toBe(90_000);
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

  async function dialogFor(event: typeof review): Promise<string[]> {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"cancelled"}', stderr: '' });
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(event, 'Work', { skipDuplicateCheck: true }),
    );
    return dialogLinesOf(osascriptImpl.mock.calls[0]?.[1][1] ?? '');
  }

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
