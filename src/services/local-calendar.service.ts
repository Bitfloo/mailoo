/**
 * Local calendar integration service.
 *
 * macOS: uses `osascript` (AppleScript) for calendar operations
 *   - Triggers the native OS permission dialog automatically on first use
 *   - Shows a native confirmation dialog before adding any event
 *
 * Linux: generates a temporary .ics file and opens it with `xdg-open`
 *   - Universal — works with GNOME Calendar, KDE Organizer, Thunderbird, etc.
 *   - No confirmation dialog (xdg-open hands off to the desktop app)
 */

import { execFile as execFileCb } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { delimitUntrusted } from '../safety/untrusted-content.js';
import {
  addEventMacOS,
  findExistingEventMacOS,
  osascriptFailure,
  statusMessage,
} from './local-calendar.macos.js';
import {
  checkPermissionsMacOS,
  listCalendarsMacOS,
  listEventsMacOS,
} from './local-calendar.macos-read.js';

export { ADD_EVENT_TIMEOUT_MS, DUPLICATE_START_WINDOW_MS } from './local-calendar.macos.js';
export {
  LIST_CALENDARS_TIMEOUT_MS,
  LIST_EVENTS_TIMEOUT_MS,
} from './local-calendar.macos-read.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SavedAttachment {
  filename: string;
  localPath: string;
  fileUrl: string;
  mimeType: string;
  size: number;
}

export interface LocalCalendarEventInput {
  title: string;
  start: Date;
  end: Date;
  location?: string;
  /** Pre-built rich notes string (from buildCalendarNotes). */
  notes?: string;
  /** Primary meeting URL (Zoom/Teams/Meet etc). */
  url?: string;
  /** Label for the meeting URL provider, e.g. "Zoom". */
  urlLabel?: string;
  /** Minutes before event to show an alert (default: 15). */
  alarmMinutes?: number;
  allDay?: boolean;
  attendeeCount?: number;
  /** Already-saved attachment list (for dialog count display). */
  savedAttachments?: SavedAttachment[];
  /** Pending (not-yet-saved) attachment metadata for dialog display. */
  pendingAttachments?: { filename: string; mimeType: string; size: number }[];
  dialIn?: string;
  meetingId?: string;
  passcode?: string;
  conferenceProvider?: string;
  /** ICS UID for duplicate detection */
  icsUid?: string;
}

export const ADD_EVENT_STATUSES = [
  'added',
  'cancelled',
  'timed_out',
  'no_display',
  'duplicate',
] as const;

export type AddEventStatus = (typeof ADD_EVENT_STATUSES)[number];

/**
 * Settled: the event is in the calendar, was already there, or the user declined it.
 * A timed-out dialog or a missing display is not; the email stays eligible for hooks, and
 * an add made through the tools is audited as an error. Keyed by every status, so a new one
 * must be placed here.
 */
const SETTLED_ADD_STATUS: Record<AddEventStatus, boolean> = {
  added: true,
  cancelled: true,
  timed_out: false,
  no_display: false,
  duplicate: true,
};

export function isSettledAddStatus(status: AddEventStatus): boolean {
  return SETTLED_ADD_STATUS[status];
}

export interface AddEventResult {
  status: AddEventStatus;
  eventId?: string;
  calendarName?: string;
  message: string;
  /** Populated when status is 'duplicate' */
  duplicate?: { eventId: string; calendarName: string };
}

export interface ExistingEventResult {
  found: boolean;
  eventId?: string;
  calendarName?: string;
  start?: string;
}

export interface CalendarInfo {
  id: string;
  name: string;
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  calendar: string;
}

export interface ListEventsOptions {
  /** Filter events whose title contains this substring (case-insensitive). */
  title?: string;
  /** Only return events on or after this date (ISO 8601). */
  from?: string;
  /** Only return events on or before this date (ISO 8601). */
  to?: string;
  /** Restrict to a specific calendar by name. */
  calendarName?: string;
  /** Maximum number of results (default 20). */
  limit?: number;
}

export interface PermissionResult {
  granted: boolean;
  platform: string;
  instructions: string[];
}

// ---------------------------------------------------------------------------
// Helper functions (declared before class to satisfy no-use-before-define)
// ---------------------------------------------------------------------------

function toICSDate(d: Date): string {
  return `${d.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

function escapeICS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function buildICS(event: LocalCalendarEventInput): string {
  const uid = `mailoo-${Date.now()}@local`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bitfloo//Mailoo//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toICSDate(new Date())}`,
    `DTSTART:${toICSDate(event.start)}`,
    `DTEND:${toICSDate(event.end)}`,
    `SUMMARY:${escapeICS(event.title)}`,
  ];
  if (event.location) lines.push(`LOCATION:${escapeICS(event.location)}`);
  if (event.notes) lines.push(`DESCRIPTION:${escapeICS(event.notes)}`);
  if (event.url) lines.push(`URL:${event.url}`);
  if (event.alarmMinutes) {
    lines.push(
      'BEGIN:VALARM',
      `TRIGGER:-PT${event.alarmMinutes}M`,
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeICS(event.title)}`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

async function addEventLinux(
  event: LocalCalendarEventInput,
  _calendarName?: string,
): Promise<AddEventResult> {
  const tmpFile = join(tmpdir(), `mailoo-event-${Date.now()}.ics`);
  const ics = buildICS(event);
  await writeFile(tmpFile, ics, 'utf8');

  try {
    await execFile('xdg-open', [tmpFile], { timeout: 10_000 });
    return {
      status: 'added',
      message: `Calendar file opened: ${delimitUntrusted(event.title)}. Confirm import in your calendar application.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'no_display',
      message: `Could not open calendar app (xdg-open failed): ${msg}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class LocalCalendarService {
  private readonly platform = process.platform;

  async checkPermissions(): Promise<PermissionResult> {
    if (this.platform === 'darwin') return checkPermissionsMacOS();
    return { granted: true, platform: 'linux', instructions: [] };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    if (this.platform !== 'darwin') {
      return [{ id: 'default', name: 'Default Calendar' }];
    }
    return listCalendarsMacOS();
  }

  async addEvent(
    event: LocalCalendarEventInput,
    calendarName?: string,
    opts: { confirm?: boolean; skipDuplicateCheck?: boolean } = {},
  ): Promise<AddEventResult> {
    const confirm = opts.confirm !== false;

    // Duplicate detection (macOS only, can opt out)
    if (this.platform === 'darwin' && opts.skipDuplicateCheck !== true) {
      let existing: ExistingEventResult;
      try {
        existing = await findExistingEventMacOS(event.title, event.start, event.icsUid);
      } catch (err) {
        return osascriptFailure('check for an existing event, so it was not added', err);
      }
      if (existing.found) {
        return {
          status: 'duplicate',
          eventId: existing.eventId,
          calendarName: existing.calendarName,
          message: statusMessage('duplicate', event.title, existing.calendarName),
          duplicate: existing.found
            ? { eventId: existing.eventId ?? '', calendarName: existing.calendarName ?? '' }
            : undefined,
        };
      }
    }

    if (this.platform === 'darwin') {
      return addEventMacOS(event, calendarName, confirm);
    }
    return addEventLinux(event, calendarName);
  }

  /** List calendar events matching the given filters. */
  async listEvents(opts: ListEventsOptions = {}): Promise<CalendarEventSummary[]> {
    if (this.platform !== 'darwin') return [];
    return listEventsMacOS(opts);
  }
}
