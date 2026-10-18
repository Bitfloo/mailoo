/**
 * macOS read side of the local calendar service: the permission check and the
 * calendar and event listings, each one osascript run.
 */

import type {
  CalendarEventSummary,
  CalendarInfo,
  ListEventsOptions,
  PermissionResult,
} from './local-calendar.service.js';
import {
  dateToAppleScriptLines,
  escapeAS,
  JSON_HANDLERS,
  parseOsascriptJson,
  runOsascript,
} from './osascript.js';

export const LIST_CALENDARS_TIMEOUT_MS = 10_000;
export const LIST_EVENTS_TIMEOUT_MS = 90_000;
// The list_events schema states this range in its from/to descriptions.
export const LIST_EVENTS_DAYS_BACK = 7;
export const LIST_EVENTS_DAYS_AHEAD = 30;

export async function checkPermissionsMacOS(): Promise<PermissionResult> {
  const script = 'tell application "Calendar" to return count of calendars';
  try {
    const count = parseInt(await runOsascript(script, 10_000), 10);
    if (count >= 0) return { granted: true, platform: 'darwin', instructions: [] };
  } catch {
    // fall through to denied
  }
  return {
    granted: false,
    platform: 'darwin',
    instructions: [
      'Calendar access was denied or unavailable.',
      '1. Open System Settings (Apple menu \u2192 System Settings)',
      '2. Go to Privacy & Security \u2192 Calendars',
      '3. Enable access for Terminal (or your terminal emulator, e.g. iTerm2)',
      '4. Quit and restart the terminal, then try again.',
    ],
  };
}

export async function listCalendarsMacOS(): Promise<CalendarInfo[]> {
  const script = `${JSON_HANDLERS}
tell application "Calendar" to set calNames to name of every calendar
set jsonResult to "["
repeat with i from 1 to count of calNames
  if i > 1 then set jsonResult to jsonResult & ","
  set jsonResult to jsonResult & my jsonString(item i of calNames)
end repeat
return jsonResult & "]"
`;
  const names = parseOsascriptJson<string[]>(
    await runOsascript(script, LIST_CALENDARS_TIMEOUT_MS),
    'list calendars',
  );
  return names.map((name) => ({ id: name, name }));
}

export async function listEventsMacOS(opts: ListEventsOptions): Promise<CalendarEventSummary[]> {
  const limit = opts.limit ?? 20;
  const titleFilter = opts.title ? escapeAS(opts.title) : '';
  const calFilter = opts.calendarName ? escapeAS(opts.calendarName) : '';

  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - LIST_EVENTS_DAYS_BACK);
  const defaultTo = new Date(now);
  defaultTo.setDate(defaultTo.getDate() + LIST_EVENTS_DAYS_AHEAD);

  const fromDate = opts.from ? new Date(opts.from) : defaultFrom;
  const toDate = opts.to ? new Date(opts.to) : defaultTo;

  const script = `${JSON_HANDLERS}
set fromDate to current date
${dateToAppleScriptLines('fromDate', fromDate).slice(1).join('\n')}

set toDate to current date
${dateToAppleScriptLines('toDate', toDate).slice(1).join('\n')}

set jsonResult to "["
set resultCount to 0
set maxResults to ${limit}
set titleFilter to "${titleFilter}"
set calFilter to "${calFilter}"

tell application "Calendar"
  repeat with c in calendars
    if resultCount ≥ maxResults then exit repeat
    set calName to name of c
    if calFilter is "" or calName is calFilter then
      try
        set evList to (every event of c whose start date ≥ fromDate and start date ≤ toDate)
        repeat with ev in evList
          if resultCount ≥ maxResults then exit repeat
          set evTitle to summary of ev
          set matchesTitle to true
          if titleFilter is not "" then
            considering case
              if evTitle does not contain titleFilter then set matchesTitle to false
            end considering
            ignoring case
              if not matchesTitle then
                if evTitle contains titleFilter then set matchesTitle to true
              end if
            end ignoring
          end if
          if matchesTitle then
            set evId to uid of ev
            set evStart to start date of ev
            set evEnd to end date of ev
            set evLoc to ""
            try
              set evLoc to location of ev
            end try
            if evLoc is missing value then set evLoc to ""
            if resultCount > 0 then set jsonResult to jsonResult & ","
            set jsonResult to jsonResult & "{\\"id\\":" & my jsonString(evId) & ",\\"title\\":" & my jsonString(evTitle) & ",\\"start\\":" & my jsonString(evStart as text) & ",\\"end\\":" & my jsonString(evEnd as text) & ",\\"location\\":" & my jsonString(evLoc) & ",\\"calendar\\":" & my jsonString(calName) & "}"
            set resultCount to resultCount + 1
          end if
        end repeat
      end try
    end if
  end repeat
end tell

set jsonResult to jsonResult & "]"
return jsonResult
`;

  return parseOsascriptJson<CalendarEventSummary[]>(
    await runOsascript(script, LIST_EVENTS_TIMEOUT_MS),
    'list events',
  );
}
