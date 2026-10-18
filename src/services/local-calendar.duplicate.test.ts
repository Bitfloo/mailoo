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

import { dateSetBy, literalAfter } from '../test-support/applescript.js';
import onDarwin from '../test-support/platform.js';
import { LIST_EVENTS_TIMEOUT_MS } from './local-calendar.macos-read.js';
import LocalCalendarService from './local-calendar.service.js';

beforeEach(() => {
  osascriptImpl.mockReset();
  osascriptImpl.mockResolvedValue({ stdout: '[]', stderr: '' });
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
    // The match can sit in another calendar than the one the add asked for.
    osascriptImpl.mockResolvedValueOnce({
      stdout: '{"found":true,"eventId":"E1","calendarName":"Home"}',
      stderr: '',
    });
    const result = await onDarwin(async () =>
      new LocalCalendarService().addEvent(standup, 'Work', { confirm: false }),
    );
    expect({
      status: result.status,
      eventId: result.eventId,
      calendarName: result.calendarName,
      duplicate: result.duplicate,
    }).toEqual({
      status: 'duplicate',
      eventId: 'E1',
      calendarName: 'Home',
      duplicate: { eventId: 'E1', calendarName: 'Home' },
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
