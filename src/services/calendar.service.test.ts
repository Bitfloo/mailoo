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
});
