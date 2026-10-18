import {
  attachmentNode,
  mixedStructure,
  withoutPartNumbers,
} from '../test-support/imap-bodystructure.js';
import {
  createMockConnectionManager,
  createMockImapClient,
  downloadReturnsPartName,
  fetchOneByUid,
  rejectCommandsDuringFetch,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  describe('getCalendarParts', () => {
    const calendarPart = {
      type: 'text/calendar',
      parameters: { method: 'REQUEST', charset: 'utf-8' },
      encoding: '7bit',
      size: 316,
      lineCount: 13,
    };

    // Outlook sends a meeting request as a text/calendar alternative with no
    // .ics attachment. imapflow reports the type as "text/calendar", no subtype.
    it('should return an inline text/calendar alternative', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: {
          childNodes: [
            {
              part: '1',
              type: 'text/plain',
              parameters: { charset: 'utf-8' },
              encoding: '7bit',
              size: 10,
              lineCount: 1,
            },
            { part: '2', ...calendarPart },
          ],
          type: 'multipart/alternative',
          parameters: { boundary: '--_NmP-cd9bb8d05f86132d-Part_1' },
        },
      });
      downloadReturnsPartName(client);

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-2']);
    });

    // RFC 3501: a non-multipart message has only part 1; imapflow gives its root no part number.
    it('should read a message that is one text/calendar part as part 1', async () => {
      fetchOneByUid(client, { uid: 9, bodyStructure: calendarPart });
      downloadReturnsPartName(client);

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-1']);
    });

    // nodemailer and Gmail attach invite.ics as application/ics, not text/calendar.
    it('should return an invite.ics attachment typed application/ics', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'invite.ics', { type: 'application/ics', size: 434 }),
        ),
      });
      downloadReturnsPartName(client);

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-2']);
    });

    // Content-Type: application/octet-stream; name="invite.ics" with a bare
    // Content-Disposition: attachment, or one that carries only size=.
    it.each([
      { label: 'no parameters', dispositionParameters: undefined },
      { label: 'only a size parameter', dispositionParameters: { size: '434' } },
    ])(
      'should return an .ics attachment named only in its Content-Type when the disposition has $label',
      async ({ dispositionParameters }) => {
        fetchOneByUid(client, {
          uid: 9,
          bodyStructure: mixedStructure(
            attachmentNode('2', 'invite.ics', {
              type: 'application/octet-stream',
              size: 434,
              dispositionParameters,
            }),
          ),
        });
        downloadReturnsPartName(client);

        const parts = await service.getCalendarParts('test', 'INBOX', '9');

        expect(parts).toEqual(['body-of-part-2']);
      },
    );

    it('should return an .ics attachment whose name is in upper case', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'INVITE.ICS', { type: 'application/octet-stream', size: 434 }),
        ),
      });
      downloadReturnsPartName(client);

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-2']);
    });

    it('should number calendar parts by position when the structure has none', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: withoutPartNumbers(mixedStructure({ part: '2', ...calendarPart })),
      });
      downloadReturnsPartName(client);

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-2']);
    });

    it('should number a nested calendar part by its dotted path when the structure has none', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: withoutPartNumbers({
          type: 'multipart/mixed',
          childNodes: [
            {
              type: 'multipart/alternative',
              childNodes: [
                { part: '1.1', type: 'text/plain', encoding: '7bit', size: 10, lineCount: 1 },
                { part: '1.2', ...calendarPart },
              ],
            },
          ],
        }),
      });
      downloadReturnsPartName(client);

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-1.2']);
    });

    it('should not treat physics.pdf as a calendar part', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'physics.pdf', { type: 'application/pdf' }),
        ),
      });
      downloadReturnsPartName(client);

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual([]);
    });

    // imapflow's fetchOne answers false for a UID the mailbox does not hold, and
    // undefined once the connection has dropped and no mailbox is selected.
    it.each([false, undefined])(
      'should return no calendar part when fetchOne returns %s',
      async (missing) => {
        client.fetchOne.mockResolvedValue(missing);

        const parts = await service.getCalendarParts('test', 'INBOX', '9');

        expect(parts).toEqual([]);
      },
    );

    // imapflow's download resolves {} when it gets no body back for the part.
    it('should skip a calendar part the server returns no content for', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure({ part: '2', ...calendarPart }),
      });
      client.download.mockResolvedValue({});

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual([]);
    });

    it('should release the mailbox lock once after reading the parts', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure({ part: '2', ...calendarPart }),
      });
      downloadReturnsPartName(client);

      await service.getCalendarParts('test', 'INBOX', '9');

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });

    it('should issue no command while a FETCH is open', async () => {
      const message = { uid: 9, bodyStructure: { part: '2', ...calendarPart } };
      fetchOneByUid(client, message);
      downloadReturnsPartName(client);
      const issuedDuringFetch = rejectCommandsDuringFetch(client, [message]);

      await service.getCalendarParts('test', 'INBOX', '9');

      expect(issuedDuringFetch).toEqual([]);
    });

    it('should read a text/calendar part attached as invite.ics once', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: {
          childNodes: [
            {
              part: '1',
              type: 'text/plain',
              parameters: { charset: 'utf-8' },
              encoding: '7bit',
              size: 10,
              lineCount: 1,
            },
            {
              part: '2',
              ...calendarPart,
              disposition: 'attachment',
              dispositionParameters: { filename: 'invite.ics' },
            },
          ],
          type: 'multipart/mixed',
          parameters: { boundary: '--_NmP-1fc051f5709d7b72-Part_1' },
        },
      });
      downloadReturnsPartName(client);

      const parts = await service.getCalendarParts('test', 'INBOX', '9');

      expect(parts).toEqual(['body-of-part-2']);
    });
  });
});
