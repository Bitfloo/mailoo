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

import LocalCalendarService, {
  dateToAppleScriptLines,
  LIST_EVENTS_TIMEOUT_MS,
} from './local-calendar.service.js';

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

// ---------------------------------------------------------------------------
// dateToAppleScriptLines
// ---------------------------------------------------------------------------

describe('dateToAppleScriptLines', () => {
  it('emits correct component-setting lines for a given date', () => {
    // Use a specific date — 19 Feb 2026 16:30:45 local time
    const d = new Date(2026, 1, 19, 16, 30, 45); // month is 0-indexed

    const lines = dateToAppleScriptLines('eventStart', d);

    expect(lines).toEqual([
      'set eventStart to current date',
      'set year of eventStart to 2026',
      'set month of eventStart to 2',
      'set day of eventStart to 19',
      'set hours of eventStart to 16',
      'set minutes of eventStart to 30',
      'set seconds of eventStart to 45',
    ]);
  });

  it('handles midnight correctly (all zeros for time)', () => {
    const d = new Date(2025, 0, 1, 0, 0, 0); // 1 Jan 2025 00:00:00

    const lines = dateToAppleScriptLines('eventEnd', d);

    expect(lines).toEqual([
      'set eventEnd to current date',
      'set year of eventEnd to 2025',
      'set month of eventEnd to 1',
      'set day of eventEnd to 1',
      'set hours of eventEnd to 0',
      'set minutes of eventEnd to 0',
      'set seconds of eventEnd to 0',
    ]);
  });

  it('handles end-of-year date', () => {
    const d = new Date(2024, 11, 31, 23, 59, 59); // 31 Dec 2024 23:59:59

    const lines = dateToAppleScriptLines('d', d);

    expect(lines).toEqual([
      'set d to current date',
      'set year of d to 2024',
      'set month of d to 12',
      'set day of d to 31',
      'set hours of d to 23',
      'set minutes of d to 59',
      'set seconds of d to 59',
    ]);
  });

  it('uses custom variable name', () => {
    const d = new Date(2026, 5, 15, 9, 0, 0);

    const lines = dateToAppleScriptLines('myDate', d);

    expect(lines[0]).toBe('set myDate to current date');
    expect(lines).toHaveLength(7);
    expect(lines.every((l) => l.includes('myDate'))).toBe(true);
  });

  it('uses local time, not UTC', () => {
    // Create a date from a UTC string — the local components should differ
    // from UTC if the test machine is not in UTC.
    // We just verify the function uses getFullYear/getHours (local), not
    // getUTCFullYear/getUTCHours.
    const d = new Date(2026, 1, 19, 16, 0, 0);
    const lines = dateToAppleScriptLines('ev', d);

    // The hour must match the local hour we set (16), regardless of UTC offset
    expect(lines).toContain('set hours of ev to 16');
  });
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
