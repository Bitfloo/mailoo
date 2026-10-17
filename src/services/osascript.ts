/**
 * One osascript runner for the Calendar and Reminders services.
 *
 * Values enter a script through `escapeAS` only. Results leave as JSON that the
 * script assembles with the `jsonString` handler, so a quote or backslash in a
 * title or calendar name cannot break parsing.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** Escapes a value for use inside an AppleScript string literal. */
export function escapeAS(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * AppleScript handlers for a script that returns JSON. `jsonString(v)` returns
 * `null` for missing value, else the text in JSON quotes with backslash and
 * quote escaped. Tabs and newlines stay raw; `parseOsascriptJson` repairs them.
 * Call them as `my jsonString(...)` inside a tell block.
 */
export const JSON_HANDLERS = String.raw`on replaceText(theText, searchText, replacementText)
  set savedDelims to AppleScript's text item delimiters
  set AppleScript's text item delimiters to searchText
  set textParts to text items of theText
  set AppleScript's text item delimiters to replacementText
  set joinedText to textParts as text
  set AppleScript's text item delimiters to savedDelims
  return joinedText
end replaceText

on jsonString(v)
  if v is missing value then return "null"
  set t to v as text
  set t to my replaceText(t, "\\", "\\\\")
  set t to my replaceText(t, "\"", "\\\"")
  return "\"" & t & "\""
end jsonString
`;

/**
 * Runs one script and returns trimmed stdout. A timeout rejects with
 * "timed out"; any other failure rejects with osascript's stderr. The default
 * execFile message repeats the whole script, which carries mail-derived text.
 */
export async function runOsascript(script: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFile('osascript', ['-e', script], { timeout: timeoutMs });
    return stdout.trim();
  } catch (err) {
    const failure = err as { killed?: boolean; code?: unknown; stderr?: unknown };
    if (failure.killed === true && failure.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error(`osascript timed out after ${Math.round(timeoutMs / 1000)} s`, {
        cause: err,
      });
    }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
    const detail = stderr || `exit ${String(failure.code ?? 'unknown')}`;
    throw new Error(`osascript failed: ${detail}`, { cause: err });
  }
}

/**
 * Parses JSON assembled by `jsonString`. AppleScript text keeps raw control
 * characters, which a JSON string may not hold; the script emits no whitespace
 * between tokens, so every control character here sits inside a string.
 */
export function parseOsascriptJson<T>(stdout: string, what: string): T {
  const repaired = Array.from(stdout, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }).join('');
  try {
    return JSON.parse(repaired) as T;
  } catch {
    // The parser message quotes the input, which carries mail-derived text.
    throw new Error(`${what}: osascript returned malformed JSON`);
  }
}
