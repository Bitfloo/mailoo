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

import { dateSetBy, literalAfter } from '../test-support/applescript.js';
import onDarwin from '../test-support/platform.js';
import { LIST_EVENTS_TIMEOUT_MS } from './local-calendar.macos-read.js';
import type { ListEventsOptions } from './local-calendar.service.js';
import LocalCalendarService from './local-calendar.service.js';

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

  it('should give list_calendars a 10 s budget', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '["Work"]', stderr: '' });
    await onDarwin(async () => new LocalCalendarService().listCalendars());
    expect(osascriptImpl.mock.calls[0]?.[2].timeout).toBe(10_000);
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

describe('listEvents script', () => {
  async function listScript(opts: ListEventsOptions): Promise<string> {
    await onDarwin(async () => new LocalCalendarService().listEvents(opts));
    return osascriptImpl.mock.calls[0]?.[1][1] ?? '';
  }

  it('should keep a quoted title and calendar filter intact in the list_events script', async () => {
    const opts = { title: 'Q3 "board" \\', calendarName: 'Home "Q4" \\ team' };
    const script = await listScript(opts);
    expect({
      title: literalAfter(script, 'set titleFilter to '),
      calendar: literalAfter(script, 'set calFilter to '),
    }).toEqual({ title: opts.title, calendar: opts.calendarName });
  });

  it('should pass the requested from date into the list_events script', async () => {
    const script = await listScript({ from: '2026-11-02T08:30:00' });
    expect(dateSetBy(script, 'fromDate', new Date(2026, 9, 31, 12, 0, 0))).toEqual(
      new Date(2026, 10, 2, 8, 30, 0),
    );
  });

  it('should pass the requested to date into the list_events script', async () => {
    const script = await listScript({ to: '2026-11-30T18:00:00' });
    expect(dateSetBy(script, 'toDate', new Date(2026, 9, 31, 12, 0, 0))).toEqual(
      new Date(2026, 10, 30, 18, 0, 0),
    );
  });

  it.each([
    [3, 'set maxResults to 3'],
    [0, 'set maxResults to 0'],
  ])('should pass limit %s into the list_events script', async (limit, line) => {
    const script = await listScript({ limit });
    expect(script.split('\n').find((text) => text.startsWith('set maxResults to '))).toBe(line);
  });

  it('should list 20 events from 7 days back to 30 days ahead by default', async () => {
    const now = new Date(2026, 9, 17, 12, 0, 0);
    vi.useFakeTimers({ now, toFake: ['Date'] });
    try {
      const script = await listScript({});
      expect({
        from: dateSetBy(script, 'fromDate', now),
        to: dateSetBy(script, 'toDate', now),
        limit: script.split('\n').find((line) => line.startsWith('set maxResults to ')),
      }).toEqual({
        from: new Date(2026, 9, 10, 12, 0, 0),
        to: new Date(2026, 10, 16, 12, 0, 0),
        limit: 'set maxResults to 20',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('should return no events off macOS without running osascript', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const events = await new LocalCalendarService().listEvents();
      expect({ events, osascriptRuns: osascriptImpl.mock.calls.length }).toEqual({
        events: [],
        osascriptRuns: 0,
      });
    } finally {
      platform.mockRestore();
    }
  });
});

describe('checkPermissions', () => {
  it('should report calendar access granted when Calendar returns its calendar count', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '4\n', stderr: '' });
    const result = await onDarwin(async () => new LocalCalendarService().checkPermissions());
    expect(result).toEqual({ granted: true, platform: 'darwin', instructions: [] });
  });

  it('should report calendar access granted when Calendar has no calendars', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '0\n', stderr: '' });
    const result = await onDarwin(async () => new LocalCalendarService().checkPermissions());
    expect(result.granted).toBe(true);
  });

  it('should give the permission check a 10 s budget', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '4\n', stderr: '' });
    await onDarwin(async () => new LocalCalendarService().checkPermissions());
    expect(osascriptImpl.mock.calls[0]?.[2].timeout).toBe(10_000);
  });

  it('should report calendar access denied when osascript rejects', async () => {
    osascriptImpl.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: osascript'), {
        killed: false,
        code: 1,
        stderr: '0:47: execution error: Not authorized to send Apple events to Calendar. (-1743)\n',
      }),
    );
    const result = await onDarwin(async () => new LocalCalendarService().checkPermissions());
    expect(result).toEqual({
      granted: false,
      platform: 'darwin',
      instructions: [
        'Calendar access was denied or unavailable.',
        '1. Open System Settings (Apple menu \u2192 System Settings)',
        '2. Go to Privacy & Security \u2192 Calendars',
        '3. Enable access for Terminal (or your terminal emulator, e.g. iTerm2)',
        '4. Quit and restart the terminal, then try again.',
      ],
    });
  });
});
