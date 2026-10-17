import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  /** Seed one message with these attachments and return its UID. */
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
