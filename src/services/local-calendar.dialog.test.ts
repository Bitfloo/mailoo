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

import { dialogLinesOf } from '../test-support/applescript.js';
import onDarwin from '../test-support/platform.js';
import type { LocalCalendarEventInput } from './local-calendar.service.js';
import LocalCalendarService from './local-calendar.service.js';
import { CONFIRM_DIALOG_WAIT_S } from './osascript.js';

beforeEach(() => {
  osascriptImpl.mockReset();
  osascriptImpl.mockResolvedValue({ stdout: '[]', stderr: '' });
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

  it('should show no attendee or attachment line when there are none', async () => {
    const lines = await dialogFor({ ...review, attendeeCount: 0, savedAttachments: [] });
    expect(lines).toEqual([
      '\u{1F4C5} Q3 "board" \\ review',
      '\u{1F550} <eventStart> \u2013 <eventEnd>',
      '\u{1F4CD} Room "Oak"',
      '\u{1F4C6} Work \u00b7 \u23f0 15 min before',
    ]);
  });

  it('should show no place line when the location is empty', async () => {
    const lines = await dialogFor({ ...review, location: '' });
    expect(lines.filter((line) => line.startsWith('\u{1F4CD}'))).toEqual([]);
  });

  it('should show a meeting ID without a PIN when there is no passcode', async () => {
    const lines = await dialogFor({ ...review, meetingId: '881 2345' });
    expect(lines[3]).toBe('\u{1F511} ID: 881 2345');
  });

  async function dialogScriptLines(): Promise<string[]> {
    await dialogFor(review);
    return (osascriptImpl.mock.calls[0]?.[1][1] ?? '').split('\n').map((line) => line.trim());
  }

  it('should add only when the default button of the dialog is pressed', async () => {
    // A compared label that is not the button's would return timed_out on every confirmed add.
    const lines = await dialogScriptLines();
    const display = lines.find((line) => line.startsWith('display dialog')) ?? '';
    const compare = lines.find((line) => line.startsWith('if dlgResult is not')) ?? '';
    expect({
      buttons: /buttons \{([^}]*)\}/.exec(display)?.[1],
      defaultButton: /default button "([^"]*)"/.exec(display)?.[1],
      cancelButton: /cancel button "([^"]*)"/.exec(display)?.[1],
      compared: /"([^"]*)"/.exec(compare)?.[1],
    }).toEqual({
      buttons: '"Cancel", "Add to Calendar"',
      defaultButton: 'Add to Calendar',
      cancelButton: 'Cancel',
      compared: 'Add to Calendar',
    });
  });

  it('should return timed_out when the dialog gives up and cancelled when it is dismissed', async () => {
    const lines = await dialogScriptLines();
    const statusAfter = (prefix: string) =>
      /status\W+(\w+)/.exec(
        lines[lines.findIndex((line) => line.startsWith(prefix)) + 1] ?? '',
      )?.[1];
    expect({
      givenUp: statusAfter('if dlgResult is not'),
      dismissed: statusAfter('on error'),
    }).toEqual({ givenUp: 'timed_out', dismissed: 'cancelled' });
  });
});
