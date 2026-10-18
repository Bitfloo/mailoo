/**
 * macOS add side of the local calendar service: the duplicate check and the add
 * script with its confirm dialog, each one osascript run.
 */

import { delimitUntrusted } from '../safety/untrusted-content.js';
import { LIST_EVENTS_TIMEOUT_MS } from './local-calendar.macos-read.js';
import type {
  AddEventResult,
  AddEventStatus,
  ExistingEventResult,
  LocalCalendarEventInput,
} from './local-calendar.service.js';
import {
  CONFIRM_DIALOG_WAIT_S,
  classifyOsascriptFailure,
  dateToAppleScriptLines,
  escapeAS,
  JSON_HANDLERS,
  parseOsascriptJson,
  runOsascript,
} from './osascript.js';

/** The confirm dialog waits up to CONFIRM_DIALOG_WAIT_S for the user; the write runs after it. */
export const ADD_EVENT_TIMEOUT_MS = 90_000;

interface JXAScriptOptions {
  event: LocalCalendarEventInput;
  calendarName: string;
  alarmMinutes: number;
  attachCount: number;
  attendeeCount: number;
  confirm: boolean;
}

/** Each item is an AppleScript expression; mail text is escaped once, where it is quoted. */
function dialogText(line: string): string {
  return `"${escapeAS(line)}"`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count > 1 ? 's' : ''}`;
}

function meetingDialogLines(event: LocalCalendarEventInput): string[] {
  const lines: string[] = [];
  if (event.location) {
    lines.push(dialogText(`\uD83D\uDCCD ${event.location}`));
  }
  if (event.url) {
    const domain = event.url.replace(/^https?:\/\//, '').split('/')[0];
    const urlLabel = event.urlLabel ?? event.conferenceProvider ?? '';
    lines.push(dialogText(`\uD83C\uDFA5 ${urlLabel || domain}`));
  }
  if (event.dialIn) {
    lines.push(dialogText(`\uD83D\uDCDE ${event.dialIn}`));
  }
  if (event.meetingId) {
    const pin = event.passcode ? ` \u00B7 PIN: ${event.passcode}` : '';
    lines.push(dialogText(`\uD83D\uDD11 ID: ${event.meetingId}${pin}`));
  }
  return lines;
}

function confirmDialogLines(opts: JXAScriptOptions): string[] {
  const { event, calendarName, alarmMinutes, attachCount, attendeeCount } = opts;
  const lines = [
    dialogText(`\uD83D\uDCC5 ${event.title}`),
    `${dialogText('\uD83D\uDD50 ')} & (eventStart as text) & ${dialogText(' \u2013 ')} & (eventEnd as text)`,
    ...meetingDialogLines(event),
  ];
  if (attendeeCount > 0) {
    lines.push(dialogText(`\uD83D\uDC65 ${plural(attendeeCount, 'attendee')}`));
  }
  if (attachCount > 0) {
    lines.push(dialogText(`\uD83D\uDCCE ${plural(attachCount, 'attachment')} saved locally`));
  }
  lines.push(
    dialogText(
      `\uD83D\uDCC6 ${calendarName || 'Default Calendar'} \u00B7 \u23F0 ${alarmMinutes} min before`,
    ),
  );
  return lines;
}

/** Shows the dialog; Cancel or a timeout returns its status before anything is written. */
function confirmDialogScript(opts: JXAScriptOptions): string[] {
  const [first, ...rest] = confirmDialogLines(opts);
  return [
    `set dialogText to ${first}`,
    ...rest.map((line) => `set dialogText to dialogText & return & ${line}`),
    'try',
    `  display dialog dialogText with title "mailoo \u2014 Add Calendar Event?" buttons {"Cancel", "Add to Calendar"} default button "Add to Calendar" cancel button "Cancel" giving up after ${CONFIRM_DIALOG_WAIT_S}`,
    '  set dlgResult to button returned of result',
    '  if dlgResult is not "Add to Calendar" then',
    '    return "{\\"status\\":\\"timed_out\\"}"',
    '  end if',
    'on error',
    '  return "{\\"status\\":\\"cancelled\\"}"',
    'end try',
    '',
  ];
}

function makeEventScript(opts: JXAScriptOptions): string[] {
  const { event, calendarName, alarmMinutes } = opts;
  const location = escapeAS(event.location ?? '');
  const notes = escapeAS(event.notes ?? '');
  const url = escapeAS(event.url ?? '');
  const calName = escapeAS(calendarName);

  const lines = ['tell application "Calendar"'];
  if (calName) {
    lines.push(
      '  try',
      `    set theCal to first calendar whose name is "${calName}"`,
      '  on error',
      '    set theCal to first calendar',
      '  end try',
    );
  } else {
    lines.push('  set theCal to first calendar');
  }
  lines.push('  set eventProps to {summary:eventTitle, start date:eventStart, end date:eventEnd}');
  if (location) {
    lines.push(`  set eventProps to eventProps & {location:"${location}"}`);
  }
  if (notes) {
    lines.push(`  set eventProps to eventProps & {description:"${notes}"}`);
  }
  if (url) {
    lines.push(`  set eventProps to eventProps & {url:"${url}"}`);
  }
  lines.push(
    '  set theEvent to make new event at end of events of theCal with properties eventProps',
  );
  if (alarmMinutes > 0) {
    lines.push(
      '  try',
      `    make new display alarm at end of display alarms of theEvent with properties {trigger interval:-${alarmMinutes * 60}}`,
      '  end try',
    );
  }
  lines.push(
    '  set eventId to uid of theEvent',
    '  set finalCalName to name of theCal',
    'end tell',
    '',
    'return "{\\"status\\":\\"added\\",\\"eventId\\":" & my jsonString(eventId) & ",\\"calendarName\\":" & my jsonString(finalCalName) & "}"',
  );
  return lines;
}

function buildAppleScript(opts: JXAScriptOptions): string {
  const { event, confirm } = opts;
  return [
    JSON_HANDLERS,
    `set eventTitle to "${escapeAS(event.title)}"`,
    '',
    ...dateToAppleScriptLines('eventStart', event.start),
    '',
    ...dateToAppleScriptLines('eventEnd', event.end),
    '',
    ...(confirm ? confirmDialogScript(opts) : []),
    ...makeEventScript(opts),
  ].join('\n');
}

export function statusMessage(
  status: AddEventStatus,
  title: string,
  calName: string | undefined,
): string {
  switch (status) {
    case 'added':
      return `\u2705 Event added: "${delimitUntrusted(title)}" \u2192 ${calName ?? 'calendar'}.`;
    case 'duplicate':
      return `\u26A0\uFE0F Event already exists in ${calName ?? 'calendar'}: "${delimitUntrusted(title)}". Skipped.`;
    case 'cancelled':
      return '\uD83D\uDEAB Cancelled \u2014 event was not added to the calendar.';
    case 'timed_out':
      return `\u23F1\uFE0F Dialog timed out after ${CONFIRM_DIALOG_WAIT_S} s \u2014 event was not added. Try again.`;
    case 'no_display':
      return '\u26A0\uFE0F No display available. Run check_calendar_permissions for setup instructions.';
    default:
      return `Unknown status: ${status as string}`;
  }
}

/** A same-titled event this close to the start is the same meeting, not the next occurrence. */
export const DUPLICATE_START_WINDOW_MS = 5 * 60_000;

/** Rejects when osascript fails, so a timeout cannot pass for "no duplicate". */
export async function findExistingEventMacOS(
  title: string,
  start: Date,
  icsUid?: string,
): Promise<ExistingEventResult> {
  const windowStart = new Date(start.getTime() - DUPLICATE_START_WINDOW_MS);
  const windowEnd = new Date(start.getTime() + DUPLICATE_START_WINDOW_MS);
  const byTitle = 'summary is searchTitle and start date ≥ windowStart and start date ≤ windowEnd';
  const whose = icsUid ? `uid is searchUid or (${byTitle})` : byTitle;

  const script = `${JSON_HANDLERS}
set searchTitle to "${escapeAS(title)}"
${icsUid ? `set searchUid to "${escapeAS(icsUid)}"` : ''}
${dateToAppleScriptLines('windowStart', windowStart).join('\n')}
${dateToAppleScriptLines('windowEnd', windowEnd).join('\n')}
tell application "Calendar"
  repeat with c in calendars
    try
      set evList to (every event of c whose ${whose})
      if (count of evList) > 0 then
        set theEvent to item 1 of evList
        set eventId to uid of theEvent
        set calName to name of c
        return "{\\"found\\":true,\\"eventId\\":" & my jsonString(eventId) & ",\\"calendarName\\":" & my jsonString(calName) & "}"
      end if
    end try
  end repeat
end tell
return "{\\"found\\":false}"
`;

  // Same whose-query over every calendar as list_events, so the same budget.
  return parseOsascriptJson<ExistingEventResult>(
    await runOsascript(script, LIST_EVENTS_TIMEOUT_MS),
    'find existing event',
  );
}

export function osascriptFailure(action: string, err: unknown): AddEventResult {
  const failure = classifyOsascriptFailure(err);
  if (failure.kind === 'cancelled') {
    return { status: 'cancelled', message: 'Cancelled by user.' };
  }
  if (failure.kind === 'denied') {
    return {
      status: 'no_display',
      message: 'Calendar access denied. Run check_calendar_permissions for setup instructions.',
    };
  }
  return { status: 'no_display', message: `Could not ${action}: ${failure.message}` };
}

export async function addEventMacOS(
  event: LocalCalendarEventInput,
  calendarName: string | undefined,
  confirm: boolean,
): Promise<AddEventResult> {
  const alarmMinutes = event.alarmMinutes ?? 15;
  const attachCount =
    (event.savedAttachments?.length ?? 0) + (event.pendingAttachments?.length ?? 0);
  const attendeeCount = event.attendeeCount ?? 0;

  const script = buildAppleScript({
    event,
    calendarName: calendarName ?? '',
    alarmMinutes,
    attachCount,
    attendeeCount,
    confirm,
  });

  try {
    const result = parseOsascriptJson<{
      status: AddEventStatus;
      eventId?: string;
      calendarName?: string;
    }>(await runOsascript(script, ADD_EVENT_TIMEOUT_MS), 'add event');
    return {
      status: result.status,
      eventId: result.eventId,
      calendarName: result.calendarName,
      message: statusMessage(result.status, event.title, result.calendarName),
    };
  } catch (err) {
    return osascriptFailure('add event', err);
  }
}
