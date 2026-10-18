import {
  createMockConnectionManager,
  createMockImapClient,
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

  // A single-message id is one canonical UID. These values are not, so
  // forwarding them selects a different set than the one message the caller named.
  describe('single-message inputs', () => {
    type Call = (svc: ImapService) => Promise<unknown>;

    it.each<[string, Call]>([
      ['getEmail', async (svc) => svc.getEmail('test', '1:*', 'INBOX')],
      ['getEmailFlags', async (svc) => svc.getEmailFlags('test', '1,2', 'INBOX')],
      ['moveEmail', async (svc) => svc.moveEmail('test', '1:5', 'INBOX', 'Archive')],
      ['deleteEmail', async (svc) => svc.deleteEmail('test', '*', 'INBOX', true)],
      ['setFlags', async (svc) => svc.setFlags('test', '0', 'INBOX', 'read')],
      ['addLabel', async (svc) => svc.addLabel('test', '-3', 'INBOX', 'Tag')],
      ['removeLabel', async (svc) => svc.removeLabel('test', '1.5', 'INBOX', 'Tag')],
      ['findEmailFolder', async (svc) => svc.findEmailFolder('test', '12abc', 'INBOX')],
      ['downloadAttachment', async (svc) => svc.downloadAttachment('test', '01', 'INBOX', 'a.txt')],
      ['exportEmail', async (svc) => svc.exportEmail('test', '1:*', 'INBOX', 1024)],
      ['getEmailSecurity', async (svc) => svc.getEmailSecurity('test', '1e2', 'INBOX')],
      ['peekText', async (svc) => svc.peekText('test', ' 4', 'INBOX')],
      ['peekAttachments', async (svc) => svc.peekAttachments('test', '$', 'INBOX')],
      [
        'saveEmailAttachments',
        async (svc) => svc.saveEmailAttachments('test', '1:*', 'INBOX', '/tmp/x'),
      ],
      ['getCalendarParts', async (svc) => svc.getCalendarParts('test', 'INBOX', '2,3')],
      ['fetchDraft', async (svc) => svc.fetchDraft('test', 0)],
      ['fetchDraft fraction', async (svc) => svc.fetchDraft('test', 1.5)],
      ['deleteDraft', async (svc) => svc.deleteDraft('test', -1, 'Drafts')],
    ])(
      'should reject an id that is not one canonical UID from %s before contacting IMAP',
      async (_name, call) => {
        await expect(call(service)).rejects.toThrow(/positive integer UID/);
        expect(connections.getImapClient).not.toHaveBeenCalled();
      },
    );

    it.each<[string, Call]>([
      ['getEmail', async (svc) => svc.getEmail('test', '8', 'INBOX\r\nSent')],
      ['getEmailFlags', async (svc) => svc.getEmailFlags('test', '8', 'IN\x00BOX')],
      ['moveEmail', async (svc) => svc.moveEmail('test', '8', 'INBOX\nSent', 'Archive')],
      ['deleteEmail', async (svc) => svc.deleteEmail('test', '8', 'INBOX\rTrash', true)],
      ['setFlags', async (svc) => svc.setFlags('test', '8', 'INBOX\x7F', 'read')],
      ['addLabel', async (svc) => svc.addLabel('test', '8', 'Box\r\nNext', 'Tag')],
      ['removeLabel', async (svc) => svc.removeLabel('test', '8', 'Box\nNext', 'Tag')],
      ['findEmailFolder', async (svc) => svc.findEmailFolder('test', '8', 'INBOX\r\nSent')],
      [
        'downloadAttachment',
        async (svc) => svc.downloadAttachment('test', '8', 'INBOX\nSent', 'a.txt'),
      ],
      ['exportEmail', async (svc) => svc.exportEmail('test', '8', 'INBOX\r\nSent', 1024)],
      ['getEmailSecurity', async (svc) => svc.getEmailSecurity('test', '8', 'INBOX\r\nSent')],
      ['peekText', async (svc) => svc.peekText('test', '8', 'INBOX\nSent')],
      ['peekAttachments', async (svc) => svc.peekAttachments('test', '8', 'INBOX\r\nSent')],
      [
        'saveEmailAttachments',
        async (svc) => svc.saveEmailAttachments('test', '8', 'INBOX\nSent', '/tmp/x'),
      ],
      ['getCalendarParts', async (svc) => svc.getCalendarParts('test', 'INBOX\r\nSent', '8')],
      ['deleteDraft', async (svc) => svc.deleteDraft('test', 8, 'Drafts\nOther')],
      ['fetchDraft', async (svc) => svc.fetchDraft('test', 8, 'Drafts\r\nOther')],
      ['bulkSetFlags', async (svc) => svc.bulkSetFlags('test', [8], 'INBOX\r\nSent', 'flag')],
      ['bulkMove source', async (svc) => svc.bulkMove('test', [8], 'INBOX\nSent', 'Archive')],
      ['bulkMove destination', async (svc) => svc.bulkMove('test', [8], 'INBOX', 'Arch\r\nive')],
      ['bulkDelete', async (svc) => svc.bulkDelete('test', [8], 'INBOX\x00')],
      ['getThread', async (svc) => svc.getThread('test', '<m@example.com>', 'INBOX\r\nSent')],
      ['extractContacts', async (svc) => svc.extractContacts('test', { mailbox: 'IN\nBOX' })],
      ['getEmailStats', async (svc) => svc.getEmailStats('test', 'INBOX\x7F', 'week')],
      ['createMailbox', async (svc) => svc.createMailbox('test', 'Work\r\nProjects')],
      ['renameMailbox source', async (svc) => svc.renameMailbox('test', 'Old\nBox', 'New')],
      ['renameMailbox target', async (svc) => svc.renameMailbox('test', 'Old', 'New\x00Box')],
      ['deleteMailbox', async (svc) => svc.deleteMailbox('test', 'Old\r\nBox')],
    ])(
      'should reject a mailbox name with a control character from %s before contacting IMAP',
      async (_name, call) => {
        await expect(call(service)).rejects.toThrow(/control characters/);
        expect(connections.getImapClient).not.toHaveBeenCalled();
      },
    );

    // bulk_action takes any JSON integer; 0 or a negative id is not a UID, and
    // imapflow would send it inside the UID set as typed.
    it.each<[string, Call]>([
      ['bulkSetFlags zero', async (svc) => svc.bulkSetFlags('test', [5, 0], 'INBOX', 'flag')],
      ['bulkMove negative', async (svc) => svc.bulkMove('test', [-4], 'INBOX', 'Archive')],
      ['bulkDelete fraction', async (svc) => svc.bulkDelete('test', [1.5], 'INBOX')],
      ['bulkDelete above 2^32-1', async (svc) => svc.bulkDelete('test', [2 ** 32], 'INBOX', true)],
    ])(
      'should reject a bulk id that is not a UID from %s before contacting IMAP',
      async (_name, call) => {
        await expect(call(service)).rejects.toThrow(/positive integer UID/);
        expect(connections.getImapClient).not.toHaveBeenCalled();
      },
    );

    it('should reject a label with an empty or relative path segment before contacting IMAP', async () => {
      await expect(service.deleteLabel('test', '../Secret')).rejects.toThrow(/relative path/);
      expect(connections.getImapClient).not.toHaveBeenCalled();
    });
  });
});
