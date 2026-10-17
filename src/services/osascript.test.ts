import type { execFile as ExecFile } from 'node:child_process';
import { promisify } from 'node:util';

import { decodeLiteral } from '../test-support/applescript.js';

const { osascriptImpl } = vi.hoisted(() => ({
  osascriptImpl: vi.fn(
    async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: '',
      stderr: '',
    }),
  ),
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => undefined, {
    [Symbol.for('nodejs.util.promisify.custom')]: osascriptImpl,
  }),
}));

import {
  classifyOsascriptFailure,
  dateToAppleScriptLines,
  escapeAS,
  JSON_HANDLERS,
  parseOsascriptJson,
  runOsascript,
} from './osascript.js';

/** Shape of the error promisified execFile rejects with (child_process docs). */
function execFailure(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('Command failed: osascript -e set t to "Quarterly board pack"'), {
    stdout: '',
    ...fields,
  });
}

describe('escapeAS', () => {
  it('should escape backslashes', () => {
    expect(escapeAS('a\\b')).toBe('a\\\\b');
  });

  it('should escape double quotes', () => {
    expect(escapeAS('say "hello"')).toBe('say \\"hello\\"');
  });

  it('should escape a backslash before a quote as two separate escapes', () => {
    expect(escapeAS('path\\to\\"file"')).toBe('path\\\\to\\\\\\"file\\"');
  });

  it('should return an empty string unchanged', () => {
    expect(escapeAS('')).toBe('');
  });

  it('should turn line breaks and tabs into AppleScript escapes', () => {
    expect(escapeAS('a\r\nb\nc\rd\te')).toBe('a\\nb\\nc\\rd\\te');
  });
});

describe('dateToAppleScriptLines', () => {
  it('should set the day to 1, then year, month, day and time from local getters', () => {
    expect(dateToAppleScriptLines('eventStart', new Date(2026, 1, 19, 16, 30, 45))).toEqual([
      'set eventStart to current date',
      'set day of eventStart to 1',
      'set year of eventStart to 2026',
      'set month of eventStart to 2',
      'set day of eventStart to 19',
      'set hours of eventStart to 16',
      'set minutes of eventStart to 30',
      'set seconds of eventStart to 45',
    ]);
  });

  it('should write midnight as zero hours, minutes and seconds', () => {
    expect(dateToAppleScriptLines('eventEnd', new Date(2025, 0, 1, 0, 0, 0)).slice(-3)).toEqual([
      'set hours of eventEnd to 0',
      'set minutes of eventEnd to 0',
      'set seconds of eventEnd to 0',
    ]);
  });

  it('should write the last second of a year as 31 December 23:59:59', () => {
    expect(dateToAppleScriptLines('d', new Date(2024, 11, 31, 23, 59, 59)).slice(2)).toEqual([
      'set year of d to 2024',
      'set month of d to 12',
      'set day of d to 31',
      'set hours of d to 23',
      'set minutes of d to 59',
      'set seconds of d to 59',
    ]);
  });
});

describe('runOsascript', () => {
  beforeEach(() => {
    osascriptImpl.mockReset();
  });

  it('should reject with "timed out" when execFile kills the process at the timeout', async () => {
    osascriptImpl.mockRejectedValueOnce(
      execFailure({ killed: true, signal: 'SIGTERM', code: null, stderr: '' }),
    );
    await expect(runOsascript('return 1', 10_000)).rejects.toThrow(
      'osascript timed out after 10 s',
    );
  });

  it('should report stderr and not the script when osascript exits non-zero', async () => {
    osascriptImpl.mockRejectedValueOnce(
      execFailure({
        killed: false,
        code: 1,
        stderr: '0:42: execution error: Not authorized to send Apple events to Calendar. (-1743)\n',
      }),
    );
    await expect(runOsascript('return 1', 10_000)).rejects.toMatchObject({
      message:
        'osascript failed: 0:42: execution error: Not authorized to send Apple events to Calendar. (-1743)',
    });
  });

  it('should return trimmed stdout on success', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"found":false}\n', stderr: '' });
    await expect(runOsascript('return 1', 10_000)).resolves.toBe('{"found":false}');
  });
});

describe('classifyOsascriptFailure', () => {
  it('should read error -128 from a dismissed dialog as cancelled', () => {
    const err = new Error('osascript failed: 0:95: execution error: User canceled. (-128)');
    expect(classifyOsascriptFailure(err).kind).toBe('cancelled');
  });

  it('should read error -1743 from a refused Apple event as denied', () => {
    const err = new Error(
      'osascript failed: 0:42: execution error: Not authorized to send Apple events to Calendar. (-1743)',
    );
    expect(classifyOsascriptFailure(err).kind).toBe('denied');
  });

  it('should keep the message of any other failure', () => {
    expect(classifyOsascriptFailure(new Error('osascript timed out after 90 s'))).toEqual({
      kind: 'failed',
      message: 'osascript timed out after 90 s',
    });
  });
});

describe('parseOsascriptJson', () => {
  it('should keep a raw tab and newline that AppleScript leaves inside a string', () => {
    expect(parseOsascriptJson('[{"title":"Plan\tQ3\nreview"}]', 'list events')).toEqual([
      { title: 'Plan\tQ3\nreview' },
    ]);
  });

  it('should name the operation and not echo the payload when the JSON is malformed', () => {
    expect(() => parseOsascriptJson('[{"title":"Board pack', 'list events')).toThrow(
      /^list events: osascript returned malformed JSON$/,
    );
  });
});

describe('JSON_HANDLERS', () => {
  /** Applies jsonString's replaceText calls in script order, as AppleScript runs them. */
  function jsonStringModel(text: string): string {
    const calls = JSON_HANDLERS.matchAll(
      /set t to my replaceText\(t, "((?:[^"\\]|\\.)*)", "((?:[^"\\]|\\.)*)"\)/g,
    );
    const escaped = Array.from(calls).reduce(
      (t, [, search = '', replacement = '']) =>
        t.split(decodeLiteral(search)).join(decodeLiteral(replacement)),
      text,
    );
    return `"${escaped}"`;
  }

  it('should escape backslash before quote so jsonString output parses back to the text', () => {
    const tricky = 'Say "hi" \\ C:\\path\\"x"';
    expect(JSON.parse(jsonStringModel(tricky))).toBe(tricky);
  });

  it('should return JSON null for a missing value', () => {
    expect(JSON_HANDLERS).toContain('if v is missing value then return "null"');
  });
});

// Opt-in only: the unit lane never starts osascript, so macOS and Linux run the same suite.
describe.runIf(process.platform === 'darwin' && process.env.MAILOO_REAL_OSASCRIPT === '1')(
  'JSON_HANDLERS under real osascript (MAILOO_REAL_OSASCRIPT=1)',
  () => {
    it('should round-trip quotes, backslashes, a tab and a newline through jsonString', async () => {
      // Pure AppleScript text handling: no application is addressed, so no permission prompt.
      const { execFile } = await vi.importActual<{ execFile: typeof ExecFile }>(
        'node:child_process',
      );
      const tricky = 'Say "hi" \\ C:\\path\tTab\nNext line';
      const script = `${JSON_HANDLERS}\nreturn "[" & my jsonString("${escapeAS(tricky)}") & "," & my jsonString(missing value) & "]"`;
      const { stdout } = await promisify(execFile)('osascript', ['-e', script], {
        timeout: 10_000,
      });
      expect(parseOsascriptJson(stdout.trim(), 'round trip')).toEqual([tricky, null]);
    });
  },
);
