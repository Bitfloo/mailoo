const { execFileImpl } = vi.hoisted(() => ({
  execFileImpl: vi.fn(
    async (
      _file: string,
      _args: string[],
      _options: { timeout?: number },
    ): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }),
  ),
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => undefined, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileImpl,
  }),
}));

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ical from 'node-ical';
import { delimitUntrusted } from '../safety/untrusted-content.js';
import type { LocalCalendarEventInput } from './local-calendar.service.js';
import LocalCalendarService from './local-calendar.service.js';

/** An invitation as hooks.service hands it over, with every character ICS must escape. */
const review: LocalCalendarEventInput = {
  title: 'Budget review',
  start: new Date('2026-10-05T07:00:00Z'),
  end: new Date('2026-10-05T08:30:00Z'),
  location: 'Room 4, floor 2',
  notes: 'Agenda; Q4\nFiles: C:\\budget\\q4.xlsx',
  url: 'https://example.zoom.us/j/8812345678?pwd=abc',
  alarmMinutes: 15,
};

let tmp = '';

beforeEach(async () => {
  execFileImpl.mockReset();
  execFileImpl.mockResolvedValue({ stdout: '', stderr: '' });
  // The service writes its .ics file to os.tmpdir(); keep it in a directory this file removes.
  tmp = await mkdtemp(path.join(os.tmpdir(), 'mailoo-linux-calendar-'));
  vi.stubEnv('TMPDIR', tmp);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

async function onLinux<T>(fn: (service: LocalCalendarService) => Promise<T>): Promise<T> {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  try {
    return await fn(new LocalCalendarService());
  } finally {
    platform.mockRestore();
  }
}

/** Adds the event on Linux and returns the calendar file xdg-open was given. */
async function addedFile(event: LocalCalendarEventInput = review): Promise<string> {
  await onLinux(async (service) => service.addEvent(event));
  return readFile(execFileImpl.mock.calls[0]?.[1][0] ?? '', 'utf8');
}

describe('LocalCalendarService on Linux', () => {
  it('should open a calendar file in the temp directory with xdg-open and a 10 s budget', async () => {
    await onLinux(async (service) => service.addEvent(review));
    const [file, args, options] = execFileImpl.mock.calls[0] ?? [];
    expect({ file, dir: path.dirname(args?.[0] ?? ''), options }).toEqual({
      file: 'xdg-open',
      dir: tmp,
      options: { timeout: 10_000 },
    });
  });

  it('should report an opened calendar file as added', async () => {
    await expect(onLinux(async (service) => service.addEvent(review))).resolves.toEqual({
      status: 'added',
      message: `Calendar file opened: ${delimitUntrusted('Budget review')}. Confirm import in your calendar application.`,
    });
  });

  it('should report a failed xdg-open as no_display with the reason', async () => {
    execFileImpl.mockRejectedValueOnce(new Error('spawn xdg-open ENOENT'));
    await expect(onLinux(async (service) => service.addEvent(review))).resolves.toEqual({
      status: 'no_display',
      message: 'Could not open calendar app (xdg-open failed): spawn xdg-open ENOENT',
    });
  });

  it('should write the start, end, title, place, notes and link a calendar app reads back', async () => {
    const [event] = Object.values(ical.sync.parseICS(await addedFile())).filter(
      (component) => component?.type === 'VEVENT',
    ) as unknown as Record<string, unknown>[];
    expect({
      start: event?.start,
      end: event?.end,
      summary: event?.summary,
      location: event?.location,
      description: event?.description,
      url: event?.url,
    }).toEqual({
      start: review.start,
      end: review.end,
      summary: review.title,
      location: review.location,
      description: review.notes,
      url: review.url,
    });
  });

  it('should escape backslash, semicolon, comma and line break in the calendar file text', async () => {
    // Checked on the raw lines: node-ical reads an escaped backslash before n back as a line break.
    const lines = (await addedFile()).split('\r\n');
    expect(lines.filter((line) => /^(LOCATION|DESCRIPTION):/.test(line))).toEqual([
      'LOCATION:Room 4\\, floor 2',
      'DESCRIPTION:Agenda\\; Q4\\nFiles: C:\\\\budget\\\\q4.xlsx',
      'DESCRIPTION:Budget review',
    ]);
  });

  it('should write a carriage return in the notes as a line break a calendar app reads back', async () => {
    const file = await addedFile({ ...review, notes: 'Line one\r\nLine two\rLine three' });
    const [event] = Object.values(ical.sync.parseICS(file)).filter(
      (component) => component?.type === 'VEVENT',
    ) as unknown as Record<string, unknown>[];
    expect(event?.description).toBe('Line one\nLine two\nLine three');
  });

  it('should end every line of the calendar file with CRLF', async () => {
    const content = await addedFile();
    expect({ bareLf: /(?<!\r)\n/.test(content), end: content.slice(-15) }).toEqual({
      bareLf: false,
      end: 'END:VCALENDAR\r\n',
    });
  });

  it('should set the alarm trigger to the alarm minutes before the start', async () => {
    const content = await addedFile();
    expect(content.split('\r\n').filter((line) => line.startsWith('TRIGGER:'))).toEqual([
      'TRIGGER:-PT15M',
    ]);
  });

  it('should escape a title with a semicolon, comma and line break in the summary and alarm text', async () => {
    const lines = (await addedFile({ ...review, title: 'Q4; budget, review\nfinal' })).split(
      '\r\n',
    );
    expect(lines.filter((line) => /^(SUMMARY|DESCRIPTION):Q4/.test(line))).toEqual([
      'SUMMARY:Q4\\; budget\\, review\\nfinal',
      'DESCRIPTION:Q4\\; budget\\, review\\nfinal',
    ]);
  });

  it('should write no alarm when alarmMinutes is 0', async () => {
    const lines = (await addedFile({ ...review, alarmMinutes: 0 })).split('\r\n');
    expect(lines.filter((line) => /^(BEGIN:VALARM|TRIGGER:)/.test(line))).toEqual([]);
  });

  it('should publish the event and show its alarm as a display alarm', async () => {
    const lines = (await addedFile()).split('\r\n');
    expect(lines.filter((line) => /^(METHOD|ACTION):/.test(line))).toEqual([
      'METHOD:PUBLISH',
      'ACTION:DISPLAY',
    ]);
  });

  it('should report calendar access as granted without instructions', async () => {
    await expect(onLinux(async (service) => service.checkPermissions())).resolves.toEqual({
      granted: true,
      platform: 'linux',
      instructions: [],
    });
  });

  it('should list one default calendar', async () => {
    await expect(onLinux(async (service) => service.listCalendars())).resolves.toEqual([
      { id: 'default', name: 'Default Calendar' },
    ]);
  });
});
