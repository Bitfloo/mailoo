/**
 * Tests for local-calendar.service helpers.
 */

import { describe, expect, it } from 'vitest';

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
import LocalCalendarService, { LIST_EVENTS_TIMEOUT_MS } from './local-calendar.service.js';

/** Runs `fn` with the service believing it is on macOS, where osascript is used. */
async function onDarwin<T>(fn: () => Promise<T>): Promise<T> {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  try {
    return await fn();
  } finally {
    platform.mockRestore();
  }
}

beforeEach(() => {
  osascriptImpl.mockReset();
  osascriptImpl.mockResolvedValue({ stdout: '[]', stderr: '' });
});

describe('listEvents timeout', () => {
  it('uses a 90s osascript timeout so multi-calendar whose-queries can finish', () => {
    expect(LIST_EVENTS_TIMEOUT_MS).toBe(90_000);
  });

  it('passes timeout 90000 into execFile, not only the exported constant', async () => {
    await onDarwin(async () => new LocalCalendarService().listEvents({ limit: 1 }));
    expect(osascriptImpl.mock.calls[0]?.[2].timeout).toBe(90_000);
  });
});

describe('osascript results', () => {
  it('should reject listEvents when osascript fails instead of reporting no events', async () => {
    osascriptImpl.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: osascript'), {
        killed: false,
        code: 1,
        stderr: 'execution error: Calendar got an error: Connection is invalid. (-609)\n',
      }),
    );
    await expect(onDarwin(async () => new LocalCalendarService().listEvents())).rejects.toThrow(
      'osascript failed: execution error: Calendar got an error: Connection is invalid. (-609)',
    );
  });

  it('should reject listCalendars when osascript fails instead of reporting no calendars', async () => {
    osascriptImpl.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: osascript'), {
        killed: false,
        code: 1,
        stderr: 'execution error: Not authorized to send Apple events to Calendar. (-1743)\n',
      }),
    );
    await expect(onDarwin(async () => new LocalCalendarService().listCalendars())).rejects.toThrow(
      'osascript failed: execution error: Not authorized to send Apple events',
    );
  });

  it('should return an event whose title holds a line break', async () => {
    // jsonString escapes backslash and quote only; AppleScript emits the line break raw.
    osascriptImpl.mockResolvedValueOnce({
      stdout:
        '[{"id":"E1","title":"Board \\"pack\\"\nreview","start":"Monday, 5 October 2026 at 09:00:00","end":"Monday, 5 October 2026 at 10:00:00","location":"","calendar":"Work"}]\n',
      stderr: '',
    });
    const events = await onDarwin(async () => new LocalCalendarService().listEvents());
    expect(events.map((e) => e.title)).toEqual(['Board "pack"\nreview']);
  });

  it('should keep a calendar name that contains a comma', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '["Work","Home, Family"]\n', stderr: '' });
    const calendars = await onDarwin(async () => new LocalCalendarService().listCalendars());
    expect(calendars).toEqual([
      { id: 'Work', name: 'Work' },
      { id: 'Home, Family', name: 'Home, Family' },
    ]);
  });

  it('should pass every listed event field through jsonString', async () => {
    await onDarwin(async () => new LocalCalendarService().listEvents());
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect(
      ['evId', 'evTitle', 'evStart as text', 'evEnd as text', 'evLoc', 'calName'].filter(
        (field) => !script.includes(`my jsonString(${field})`),
      ),
    ).toEqual([]);
  });
});

describe('addEvent duplicate check', () => {
  /** Mirrors the event shape hooks.service builds from an invitation. */
  const standup = {
    title: 'Weekly standup',
    start: new Date(2026, 9, 5, 9, 0, 0),
    end: new Date(2026, 9, 5, 9, 30, 0),
    icsUid: '040000008200E00074C5B7101A82E008@example.com',
  };

  function findScript(): string {
    return osascriptImpl.mock.calls[0]?.[1][1] ?? '';
  }

  it('should not add the event when the duplicate check times out', async () => {
    osascriptImpl
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: osascript'), {
          killed: true,
          signal: 'SIGTERM',
          code: null,
          stderr: '',
        }),
      )
      .mockResolvedValueOnce({
        stdout: '{"status":"added","eventId":"E2","calendarName":"Work"}',
        stderr: '',
      });
    const result = await onDarwin(async () =>
      new LocalCalendarService().addEvent(standup, 'Work', { confirm: false }),
    );
    expect({ result, osascriptRuns: osascriptImpl.mock.calls.length }).toEqual({
      result: {
        status: 'no_display',
        message:
          'Could not check for an existing event, so it was not added: osascript timed out after 90 s',
      },
      osascriptRuns: 1,
    });
  });

  it('should give the duplicate check the same 90 s budget as list_events', async () => {
    // A timed-out check refuses the add.
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(standup, 'Work', { confirm: false }),
    );
    expect(osascriptImpl.mock.calls[0]?.[2].timeout).toBe(LIST_EVENTS_TIMEOUT_MS);
  });

  it('should search every calendar for the ICS UID', async () => {
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(standup, 'Work', { confirm: false }),
    );
    expect(literalAfter(findScript(), 'set searchUid to ')).toBe(standup.icsUid);
  });

  it('should search for the title from five minutes before to five minutes after the start', async () => {
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(standup, 'Work', { confirm: false }),
    );
    const now = new Date(2026, 9, 1, 12, 0, 0);
    expect([
      dateSetBy(findScript(), 'windowStart', now),
      dateSetBy(findScript(), 'windowEnd', now),
    ]).toEqual([new Date(2026, 9, 5, 8, 55, 0), new Date(2026, 9, 5, 9, 5, 0)]);
  });

  it('should match the ICS UID or the title within the start window', async () => {
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(standup, 'Work', { confirm: false }),
    );
    expect(findScript()).toContain(
      'whose uid is searchUid or (summary is searchTitle and start date ≥ windowStart and start date ≤ windowEnd)',
    );
  });

  it('should match title and start window alone when the event has no ICS UID', async () => {
    await onDarwin(async () =>
      new LocalCalendarService().addEvent({ ...standup, icsUid: undefined }, 'Work', {
        confirm: false,
      }),
    );
    expect(findScript()).toContain(
      'whose summary is searchTitle and start date ≥ windowStart and start date ≤ windowEnd)',
    );
  });

  it('should keep a quoted title and ICS UID intact in the duplicate-check script', async () => {
    const invite = { ...standup, title: 'Q3 "board" \\ sync', icsUid: 'uid-"7"\\@example.com' };
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(invite, 'Work', { confirm: false }),
    );
    expect({
      title: literalAfter(findScript(), 'set searchTitle to '),
      uid: literalAfter(findScript(), 'set searchUid to '),
    }).toEqual({ title: invite.title, uid: invite.icsUid });
  });

  it('should build the found event id and calendar name through jsonString', async () => {
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(standup, 'Work', { confirm: false }),
    );
    expect(
      ['eventId', 'calName'].filter((field) => !findScript().includes(`my jsonString(${field})`)),
    ).toEqual([]);
  });

  it('should report the matching event as a duplicate', async () => {
    osascriptImpl.mockResolvedValueOnce({
      stdout: '{"found":true,"eventId":"E1","calendarName":"Work"}',
      stderr: '',
    });
    const result = await onDarwin(async () =>
      new LocalCalendarService().addEvent(standup, 'Work', { confirm: false }),
    );
    expect({ status: result.status, duplicate: result.duplicate }).toEqual({
      status: 'duplicate',
      duplicate: { eventId: 'E1', calendarName: 'Work' },
    });
  });

  it('should not run the add script when an event matches', async () => {
    osascriptImpl.mockResolvedValueOnce({
      stdout: '{"found":true,"eventId":"E1","calendarName":"Work"}',
      stderr: '',
    });
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(standup, 'Work', { confirm: false }),
    );
    const scripts = osascriptImpl.mock.calls.map((call) => call[1][1] ?? '');
    expect(scripts.filter((script) => script.includes('make new event'))).toEqual([]);
  });
});

describe('addEvent script', () => {
  const offsite = {
    title: 'Q3 "board" \\ offsite',
    start: new Date(2026, 9, 5, 9, 0, 0),
    end: new Date(2026, 9, 5, 17, 0, 0),
    location: 'Hall "B", C:\\maps',
    notes: 'Agenda:\n"budget" \\ hiring',
  };

  async function addScript(): Promise<string> {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"added"}', stderr: '' });
    await onDarwin(async () =>
      new LocalCalendarService().addEvent(offsite, 'Work', {
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
