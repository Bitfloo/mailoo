import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

/**
 * imapflow runs one command at a time, so a part fetch issued inside an open
 * FETCH loop never starts and the call hangs until the 300 s socket timeout.
 * 10 s is far above a healthy calendar-part read on GreenMail and keeps that red fast.
 */
const CALENDAR_PARTS_TIMEOUT_MS = 10_000;

const EVENT_UID = 'mailoo-calendar-part@example.test';

const INVITE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Mailoo//Integration//EN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  `UID:${EVENT_UID}`,
  'DTSTAMP:20260101T090000Z',
  'DTSTART:20260115T100000Z',
  'DTEND:20260115T110000Z',
  'SUMMARY:Calendar part after the fetch loop',
  'ORGANIZER:mailto:alice@example.test',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const INLINE_CALENDAR_TYPE = 'text/calendar; charset=utf-8; method=REQUEST';

describe('Calendar part extraction', () => {
  let services: TestServices;

  async function seedAndFind(subject: string, options: Parameters<typeof seedEmail>[0]) {
    await seedEmail({ from: 'alice@localhost', subject, ...options });
    await waitForDelivery(subject);
    const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { subject });
    return list.items[0].id;
  }

  beforeAll(() => {
    services = createTestServices(buildTestAccount());
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  it(
    'should return the decoded iCalendar text of an invite',
    async () => {
      const emailId = await seedAndFind('Calendar invite after the fetch loop', {
        text: 'Invitation',
        icalEvent: { method: 'REQUEST', content: INVITE_ICS },
      });

      const parts = await services.imapService.getCalendarParts(
        TEST_ACCOUNT_NAME,
        'INBOX',
        emailId,
      );

      expect(parts.join('\n')).toContain(`UID:${EVENT_UID}`);
    },
    CALENDAR_PARTS_TIMEOUT_MS,
  );

  // Outlook sends a meeting request as a text/calendar alternative with no
  // .ics attachment; imapflow reports its type as "text/calendar".
  it(
    'should return an inline text/calendar alternative that has no .ics attachment',
    async () => {
      const emailId = await seedAndFind('Inline calendar alternative', {
        text: 'Invitation',
        alternatives: [{ contentType: INLINE_CALENDAR_TYPE, content: INVITE_ICS }],
      });

      const parts = await services.imapService.getCalendarParts(
        TEST_ACCOUNT_NAME,
        'INBOX',
        emailId,
      );

      expect(parts.join('\n')).toContain(`UID:${EVENT_UID}`);
    },
    CALENDAR_PARTS_TIMEOUT_MS,
  );

  it(
    'should return the body of a message that is one text/calendar part',
    async () => {
      const emailId = await seedAndFind('Single-part calendar message', {
        text: '',
        alternatives: [{ contentType: INLINE_CALENDAR_TYPE, content: INVITE_ICS }],
      });

      const parts = await services.imapService.getCalendarParts(
        TEST_ACCOUNT_NAME,
        'INBOX',
        emailId,
      );

      expect(parts.join('\n')).toContain(`UID:${EVENT_UID}`);
    },
    CALENDAR_PARTS_TIMEOUT_MS,
  );
});
