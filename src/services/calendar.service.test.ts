import CalendarService from './calendar.service.js';

/** A REQUEST as Exchange sends it: SUMMARY, LOCATION and DESCRIPTION carry LANGUAGE. */
const EXCHANGE_INVITE = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'ORGANIZER;CN=Alice:mailto:alice@example.com',
  'DESCRIPTION;LANGUAGE=en-US:Agenda: Q4 budget\\n',
  'SUMMARY;LANGUAGE=en-US:Planning sync',
  'DTSTART:20261005T080000Z',
  'DTEND:20261005T083000Z',
  'UID:040000008200E00074C5B7101A82E008',
  'DTSTAMP:20260921T070000Z',
  'LOCATION;LANGUAGE=en-US:Room 4',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** A REQUEST as Google Calendar sends it: the same properties without parameters. */
const GOOGLE_INVITE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'DTSTART:20261005T080000Z',
  'DTEND:20261005T083000Z',
  'DTSTAMP:20260921T070000Z',
  'ORGANIZER;CN=Alice:mailto:alice@example.com',
  'UID:7kq2m1v9c3example@google.com',
  'DESCRIPTION:Agenda: Q4 budget\\n',
  'LOCATION:Room 4',
  'STATUS:CONFIRMED',
  'SUMMARY:Planning sync',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

/** One VEVENT in a REQUEST calendar; `lines` go between BEGIN:VEVENT and END:VEVENT. */
function invite(...lines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function vevent(uid: string, start: string): string[] {
  return [`UID:${uid}`, `DTSTART:${start}`, 'DTEND:20261231T235900Z', 'SUMMARY:Planning sync'];
}

describe('CalendarService.parseIcs', () => {
  it('should read a SUMMARY, LOCATION and DESCRIPTION without parameters as text', () => {
    const [event] = CalendarService.parseIcs(GOOGLE_INVITE);
    expect({
      summary: event?.summary,
      location: event?.location,
      description: event?.description,
    }).toEqual({
      summary: 'Planning sync',
      location: 'Room 4',
      description: 'Agenda: Q4 budget\n',
    });
  });

  it('should read a SUMMARY, LOCATION and DESCRIPTION with a LANGUAGE parameter as text', () => {
    const [event] = CalendarService.parseIcs(EXCHANGE_INVITE);
    expect({
      summary: event?.summary,
      location: event?.location,
      description: event?.description,
    }).toEqual({
      summary: 'Planning sync',
      location: 'Room 4',
      description: 'Agenda: Q4 budget\n',
    });
  });

  it('should read a UID and STATUS with a parameter as text', () => {
    // RFC 5545 allows an X- parameter on any property; node-ical then returns `{ val, params }`.
    const ics = EXCHANGE_INVITE.replace('UID:', 'UID;X-SOURCE=1:').replace(
      'STATUS:CONFIRMED',
      'STATUS;X-SOURCE=1:CANCELLED',
    );
    const [event] = CalendarService.parseIcs(ics);
    expect({ uid: event?.uid, status: event?.status }).toEqual({
      uid: '040000008200E00074C5B7101A82E008',
      status: 'CANCELLED',
    });
  });

  it.each(['REQUEST', 'CANCEL'])('should read a METHOD:%s that carries a parameter', (method) => {
    const ics = invite(...vevent('method-1', '20261005T080000Z')).replace(
      'METHOD:REQUEST',
      `METHOD;X-PARAM=1:${method}`,
    );
    expect(CalendarService.parseIcs(ics)[0]?.method).toBe(method);
  });

  it('should leave summary, description and location at their defaults when the invitation has none', () => {
    const [event] = CalendarService.parseIcs(
      invite('UID:bare-1', 'DTSTART:20261005T080000Z', 'DTEND:20261005T083000Z'),
    );
    expect({
      summary: event?.summary,
      description: event?.description,
      location: event?.location,
    }).toEqual({ summary: '(No title)', description: undefined, location: undefined });
  });

  it('should read the method, recurrence, organizer and attendees of a recurring invitation', () => {
    const [event] = CalendarService.parseIcs(
      invite(
        ...vevent('weekly-1', '20261005T080000Z'),
        'ORGANIZER;CN=Alice:mailto:alice@example.com',
        'ATTENDEE;CN=Bob;ROLE=REQ-PARTICIPANT:mailto:bob@example.com',
        'ATTENDEE:mailto:carol@example.com',
        'ATTENDEE;CN=Projector;CUTYPE=RESOURCE:',
        'RRULE:FREQ=WEEKLY;COUNT=4',
      ),
    );
    expect({
      method: event?.method,
      rrule: event?.recurrence?.split('\n').at(-1),
      organizer: event?.organizer,
      attendees: event?.attendees,
    }).toEqual({
      method: 'REQUEST',
      rrule: 'RRULE:FREQ=WEEKLY;COUNT=4',
      organizer: { name: 'Alice', address: 'alice@example.com' },
      attendees: [{ name: 'Bob', address: 'bob@example.com' }, { address: 'carol@example.com' }],
    });
  });

  it('should leave start and end empty when the invitation has neither DTSTART nor DTEND', () => {
    const [event] = CalendarService.parseIcs(invite('UID:undated-1', 'SUMMARY:Planning sync'));
    expect({ start: event?.start, end: event?.end }).toEqual({ start: '', end: '' });
  });

  it('should strip mailto: from an organizer without parameters', () => {
    const [event] = CalendarService.parseIcs(
      invite(...vevent('org-1', '20261005T080000Z'), 'ORGANIZER:mailto:alice@example.com'),
    );
    expect(event?.organizer).toEqual({ address: 'alice@example.com' });
  });

  it('should read a TENTATIVE status written in lower case', () => {
    const [event] = CalendarService.parseIcs(
      invite(...vevent('tent-1', '20261005T080000Z'), 'STATUS:tentative'),
    );
    expect(event?.status).toBe('TENTATIVE');
  });

  it('should order the events of one calendar by start', () => {
    const ics = invite(
      ...vevent('late', '20261007T080000Z'),
      'END:VEVENT',
      'BEGIN:VEVENT',
      ...vevent('early', '20261005T080000Z'),
    );
    expect(CalendarService.parseIcs(ics).map((event) => event.uid)).toEqual(['early', 'late']);
  });
});

describe('CalendarService.extractFromParts', () => {
  it('should keep the first event of a UID that a later part repeats', () => {
    const first = invite(...vevent('standup', '20261005T080000Z'));
    const update = invite(...vevent('standup', '20261006T080000Z'));
    const events = new CalendarService().extractFromParts([first, update]);
    expect(events.map((event) => event.start)).toEqual(['2026-10-05T08:00:00.000Z']);
  });

  it('should order the events of all parts by start', () => {
    const late = invite(...vevent('late', '20261007T080000Z'));
    const early = invite(...vevent('early', '20261005T080000Z'));
    const events = new CalendarService().extractFromParts([late, early]);
    expect(events.map((event) => event.uid)).toEqual(['early', 'late']);
  });
});
