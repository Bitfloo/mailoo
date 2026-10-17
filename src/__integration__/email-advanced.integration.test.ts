import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  seedEmailWithAttachment,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Advanced Email Operations', () => {
  let services: TestServices;

  async function seedAndFind(
    subject: string,
    attachments: { filename: string; content: string; contentType: string }[],
  ): Promise<string> {
    await seedEmail({ subject, attachments });
    await waitForDelivery();
    const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { subject });
    expect(list.items).toHaveLength(1);
    return list.items[0].id;
  }

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // download_attachment
  // ---------------------------------------------------------------------------

  describe('downloadAttachment', () => {
    it('should download a text attachment', async () => {
      await seedEmailWithAttachment('readme.txt', 'Hello attachment world');
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Email with attachment',
        hasAttachment: true,
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);

      const emailId = list.items[0].id;

      const attachment = await services.imapService.downloadAttachment(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        'readme.txt',
      );

      expect(attachment).toBeDefined();
      expect(attachment.filename).toBe('readme.txt');
      expect(attachment.contentBase64).toBeTruthy();

      // Decode and verify content
      const decoded = Buffer.from(attachment.contentBase64, 'base64').toString('utf-8');
      expect(decoded).toContain('Hello attachment world');
    });

    it('should download a binary attachment', async () => {
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await seedEmailWithAttachment('image.png', binaryContent.toString('base64'), {
        subject: 'Binary attachment email',
      });
      await waitForDelivery();

      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Binary attachment email',
      });

      if (list.items.length > 0) {
        const attachment = await services.imapService.downloadAttachment(
          TEST_ACCOUNT_NAME,
          list.items[0].id,
          'INBOX',
          'image.png',
        );
        expect(attachment.filename).toBe('image.png');
      }
    });

    it('should reject a sequence-set id before downloading', async () => {
      await expect(
        services.imapService.downloadAttachment(TEST_ACCOUNT_NAME, '1:*', 'INBOX', 'readme.txt'),
      ).rejects.toThrow(/positive integer UID/);
    });

    it('should refuse a filename two attachments share and name their MIME parts', async () => {
      const emailId = await seedAndFind('Twin attachments download', [
        { filename: 'notes.txt', content: 'first-notes', contentType: 'text/plain' },
        { filename: 'notes.txt', content: 'second-notes', contentType: 'text/plain' },
      ]);

      await expect(
        services.imapService.downloadAttachment(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'notes.txt'),
      ).rejects.toThrow('matches 2 attachments in email');
    });
  });

  // ---------------------------------------------------------------------------
  // saveEmailAttachments (calendar notes and the mail-arrival hook)
  // ---------------------------------------------------------------------------

  describe('saveEmailAttachments', () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'mailoo-save-'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('should save each attachment when two share a filename', async () => {
      const emailId = await seedAndFind('Twin attachments save', [
        { filename: 'notes.txt', content: 'first-notes', contentType: 'text/plain' },
        { filename: 'notes.txt', content: 'second-notes', contentType: 'text/plain' },
      ]);
      const destDir = join(root, 'out');

      const saved = await services.imapService.saveEmailAttachments(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        destDir,
      );

      const contents = await Promise.all(saved.map(async (s) => readFile(s.localPath, 'utf-8')));
      expect(contents.sort()).toEqual(['first-notes', 'second-notes']);
    });

    it('should write an attachment named ".." inside the destination directory', async () => {
      const emailId = await seedAndFind('Dot-dot attachment save', [
        { filename: '..', content: 'dot-dot-body', contentType: 'text/plain' },
      ]);
      const destDir = join(root, 'out');

      const saved = await services.imapService.saveEmailAttachments(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        destDir,
      );

      expect(saved.map((s) => relative(destDir, s.localPath))).toEqual(['attachment']);
    });

    it('should strip directories from a traversal filename', async () => {
      const emailId = await seedAndFind('Traversal attachment save', [
        { filename: '../../evil.txt', content: 'evil-body', contentType: 'text/plain' },
      ]);
      const destDir = join(root, 'a', 'b');

      const saved = await services.imapService.saveEmailAttachments(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        destDir,
      );

      expect(saved.map((s) => relative(destDir, s.localPath))).toEqual(['evil.txt']);
    });
  });

  // ---------------------------------------------------------------------------
  // Part downloads address the message by UID
  // ---------------------------------------------------------------------------

  // A fresh GreenMail folder numbers messages with sequence number == UID.
  // Expunging the first of two leaves the second at sequence 1 and UID 2, so
  // a part read by sequence number asks for a message that does not exist.
  describe('when the sequence number differs from the UID', () => {
    const folder = 'Sequence Gap';
    const eventUid = 'mailoo-sequence-gap@example.test';
    let emailId: string;
    let root: string;

    beforeAll(async () => {
      const subject = 'Sequence number differs from the UID';
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, folder);
      await seedEmail({ subject, text: 'expunged-first' });
      await seedEmail({
        subject,
        text: 'Invitation',
        attachments: [
          { filename: 'agenda.txt', content: 'agenda-body', contentType: 'text/plain' },
        ],
        icalEvent: {
          method: 'REQUEST',
          content: [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Mailoo//Integration//EN',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            `UID:${eventUid}`,
            'DTSTAMP:20260101T090000Z',
            'DTSTART:20260115T100000Z',
            'DTEND:20260115T110000Z',
            'SUMMARY:Sequence gap',
            'END:VEVENT',
            'END:VCALENDAR',
            '',
          ].join('\r\n'),
        },
      });
      await waitForDelivery();
      const inbox = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { subject });
      const byUid = (a: string, b: string) => Number(a) - Number(b);
      const ids = inbox.items.map((m) => m.id).sort(byUid);
      await services.imapService.bulkMove(TEST_ACCOUNT_NAME, ids.map(Number), 'INBOX', folder);
      const moved = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { mailbox: folder });
      const [first, second] = moved.items.map((m) => m.id).sort(byUid);
      await services.imapService.deleteEmail(TEST_ACCOUNT_NAME, first, folder, true);
      emailId = second;
      if (emailId === '1') throw new Error('fixture expects the remaining message to have UID 2');
    });

    afterAll(async () => {
      await services.imapService.deleteMailbox(TEST_ACCOUNT_NAME, folder);
    });

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'mailoo-seq-'));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('should download the attachment of the message the UID names', async () => {
      const attachment = await services.imapService.downloadAttachment(
        TEST_ACCOUNT_NAME,
        emailId,
        folder,
        'agenda.txt',
      );

      expect(Buffer.from(attachment.contentBase64, 'base64').toString('utf-8')).toBe('agenda-body');
    });

    it('should save the attachments of the message the UID names', async () => {
      const saved = await services.imapService.saveEmailAttachments(
        TEST_ACCOUNT_NAME,
        emailId,
        folder,
        root,
      );

      const contents = await Promise.all(saved.map(async (s) => readFile(s.localPath, 'utf-8')));
      expect(contents).toEqual(['agenda-body']);
    });

    it('should read the calendar part of the message the UID names', async () => {
      const parts = await services.imapService.getCalendarParts(TEST_ACCOUNT_NAME, folder, emailId);

      expect(parts.join('\n')).toContain(`UID:${eventUid}`);
    });
  });

  // ---------------------------------------------------------------------------
  // extract_contacts
  // ---------------------------------------------------------------------------

  describe('extractContacts', () => {
    it('should extract contacts with frequency data', async () => {
      const contacts = await services.imapService.extractContacts(TEST_ACCOUNT_NAME, {
        limit: 50,
      });

      expect(contacts).toBeInstanceOf(Array);
      expect(contacts.length).toBeGreaterThanOrEqual(1);

      // Contacts should have email address
      for (const contact of contacts) {
        expect(contact.email).toBeTruthy();
        expect(contact.frequency).toBeGreaterThanOrEqual(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // find_email_folder
  // ---------------------------------------------------------------------------

  describe('findEmailFolder', () => {
    it('should locate email in INBOX', async () => {
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { pageSize: 1 });

      if (list.items.length > 0) {
        const result = await services.imapService.findEmailFolder(
          TEST_ACCOUNT_NAME,
          list.items[0].id,
          'INBOX',
        );

        expect(result.folders).toContain('INBOX');
      }
    });
  });
});
