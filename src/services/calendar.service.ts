/**
 * Calendar service — ICS/iCalendar parsing.
 *
 * Extracts structured calendar events from ICS content using node-ical.
 */

import type { CalendarComponent } from 'node-ical';
import ical from 'node-ical';

import type { CalendarEvent, EmailAddress } from '../types/index.js';

type IcalComponent = CalendarComponent;

export default class CalendarService {
  /**
   * Parse ICS text content into structured CalendarEvent objects.
   */
  static parseIcs(content: string): CalendarEvent[] {
    const parsed = ical.sync.parseICS(content);
    const events: CalendarEvent[] = [];

    // node-ical moves a plain METHOD into `vcalendar` but leaves one with a parameter on the root.
    const root = parsed as unknown as Record<string, unknown>;
    const vcalendar = root.vcalendar as Record<string, unknown> | undefined;
    const calendarMethod = CalendarService.text(vcalendar?.method ?? root.method);

    Object.values(parsed).forEach((comp: IcalComponent | undefined) => {
      if (comp?.type !== 'VEVENT') return;

      const event = comp as unknown as Record<string, unknown>;
      const start = event.start as Date | undefined;
      const end = event.end as Date | undefined;
      const organizer = CalendarService.parseOrganizer(event.organizer);
      const attendees = CalendarService.parseAttendees(event.attendee);
      const rrule = event.rrule as { toString: () => string } | undefined;

      events.push({
        uid: CalendarService.text(event.uid) ?? '',
        summary: CalendarService.text(event.summary) ?? '(No title)',
        description: CalendarService.text(event.description),
        start: CalendarService.iso(start),
        end: CalendarService.iso(end),
        location: CalendarService.text(event.location),
        organizer,
        attendees,
        status: CalendarService.normalizeStatus(CalendarService.text(event.status)),
        method: calendarMethod,
        recurrence: rrule?.toString(),
      });
    });

    // Sort by start time
    events.sort((a, b) => a.start.localeCompare(b.start));

    return events;
  }

  /**
   * Extract calendar events from raw email body parts.
   * Accepts an array of ICS content strings (from inline text/calendar parts
   * or downloaded .ics attachments).
   */
  // eslint-disable-next-line class-methods-use-this
  extractFromParts(icsContents: string[]): CalendarEvent[] {
    const allEvents: CalendarEvent[] = [];
    const seenUids = new Set<string>();

    icsContents.forEach((content) => {
      const events = CalendarService.parseIcs(content);
      events.forEach((event) => {
        if (!seenUids.has(event.uid)) {
          seenUids.add(event.uid);
          allEvents.push(event);
        }
      });
    });

    allEvents.sort((a, b) => a.start.localeCompare(b.start));
    return allEvents;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** node-ical gives `{ val, params }` instead of a string once a property has a parameter. */
  private static text(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    const val = (value as { val?: unknown } | undefined)?.val;
    return typeof val === 'string' ? val : undefined;
  }

  /** node-ical gives an invalid `end` when an event has neither DTSTART nor DTEND. */
  private static iso(date: Date | undefined): string {
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
  }

  private static parseOrganizer(organizer: unknown): EmailAddress | undefined {
    if (!organizer) return undefined;

    if (typeof organizer === 'string') {
      const email = organizer.replace(/^mailto:/i, '');
      return { address: email };
    }

    const org = organizer as Record<string, unknown>;
    const val = (org.val as string | undefined) ?? '';
    const email = val.replace(/^mailto:/i, '');
    return {
      name: (org.params as Record<string, unknown>)?.CN as string | undefined,
      address: email,
    };
  }

  private static parseAttendees(attendees: unknown): EmailAddress[] {
    if (!attendees) return [];

    const list = Array.isArray(attendees) ? attendees : [attendees];
    return list
      .map((att) => {
        if (typeof att === 'string') {
          return { address: att.replace(/^mailto:/i, '') };
        }
        const a = att as Record<string, unknown>;
        const val = (a.val as string | undefined) ?? '';
        const email = val.replace(/^mailto:/i, '');
        return {
          name: (a.params as Record<string, unknown>)?.CN as string | undefined,
          address: email,
        };
      })
      .filter((a) => a.address);
  }

  private static normalizeStatus(
    status: string | undefined,
  ): 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED' {
    const upper = (status ?? 'CONFIRMED').toUpperCase();
    if (upper === 'TENTATIVE') return 'TENTATIVE';
    if (upper === 'CANCELLED') return 'CANCELLED';
    return 'CONFIRMED';
  }
}
