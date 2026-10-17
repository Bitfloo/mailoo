/**
 * Limits and timeouts the docs state as numbers, read from the doc text and compared
 * with the constant the code uses, so a changed limit cannot leave its doc line behind.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import HooksService from './services/hooks.service.js';
import {
  DUPLICATE_START_WINDOW_MS,
  LIST_CALENDARS_TIMEOUT_MS,
  LIST_EVENTS_TIMEOUT_MS,
} from './services/local-calendar.service.js';
import { LIST_REMINDERS_TIMEOUT_MS } from './services/reminders.service.js';
import { MAX_HTML_INPUT_CHARS } from './utils/email-body.js';

const root = fileURLToPath(new URL('..', import.meta.url));

let toolsDoc = '';
let readme = '';

beforeAll(async () => {
  [toolsDoc, readme] = await Promise.all([
    readFile(`${root}docs/tools.md`, 'utf8'),
    readFile(`${root}README.md`, 'utf8'),
  ]);
});

/** The first capture group of `pattern` in `text`; throws when the doc line is gone. */
function stated(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match?.[1]) throw new Error(`doc text not found: ${pattern.source}`);
  return match[1];
}

describe('documented limits', () => {
  it('should state the HTML conversion cap in docs/tools.md as MAX_HTML_INPUT_CHARS', () => {
    expect(stated(toolsDoc, /from\s+its\s+first\s+([\d,]+)\s+characters/)).toBe(
      MAX_HTML_INPUT_CHARS.toLocaleString('en-US'),
    );
  });

  it('should state the new-mail queue cap in README.md as MAX_PENDING_EMAILS', () => {
    expect(Number(stated(readme, /At\s+most\s+(\d+)\s+new\s+emails\s+wait/))).toBe(
      HooksService.MAX_PENDING_EMAILS,
    );
  });

  it.each([
    ['list_events', LIST_EVENTS_TIMEOUT_MS],
    ['list_reminders', LIST_REMINDERS_TIMEOUT_MS],
    ['list_calendars', LIST_CALENDARS_TIMEOUT_MS],
  ])('should state the %s osascript timeout in docs/tools.md', (tool, timeoutMs) => {
    expect(Number(stated(toolsDoc, new RegExp(`\`${tool}\`\\s+(\\d+)\\s+s\\b`)))).toBe(
      timeoutMs / 1000,
    );
  });

  it('should state the duplicate-check timeout in docs/tools.md as the list_events budget', () => {
    expect(Number(stated(toolsDoc, /check\s+fails\s+or\s+times\s+out\s+\((\d+)\s+s\)/))).toBe(
      LIST_EVENTS_TIMEOUT_MS / 1000,
    );
  });

  it('should state the duplicate start window in docs/tools.md as DUPLICATE_START_WINDOW_MS', () => {
    expect(Number(stated(toolsDoc, /starting\s+within\s+(\d+)\s+minutes/))).toBe(
      DUPLICATE_START_WINDOW_MS / 60_000,
    );
  });
});
