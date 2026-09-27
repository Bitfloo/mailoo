import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('Email Draft Operations', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    // GreenMail does not auto-create Drafts — create it explicitly
    try {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Drafts');
    } catch {
      // Already exists, ignore
    }
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  // ---------------------------------------------------------------------------
  // save_draft
  // ---------------------------------------------------------------------------

  describe('saveDraft', () => {
    it('should save a draft to Drafts folder', async () => {
      const result = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Draft test',
        body: 'This is a draft.',
      });

      expect(result).toBeDefined();
      expect(result.id).toBeTruthy();
      expect(result.mailbox).toBeTruthy();
    });

    it('should save a draft without recipients', async () => {
      const result = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
        to: [],
        subject: 'Empty draft',
        body: 'Draft with no recipients.',
      });

      expect(result.id).toBeTruthy();
    });

    it('should save a draft attachment read from the working directory', async () => {
      const dir = await fs.mkdtemp(path.join(process.cwd(), 'tmp-mailoo-out-'));
      const marker = `draft-payload-${Date.now()}`;
      try {
        const file = path.join(dir, 'note.txt');
        await fs.writeFile(file, marker);
        const result = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
          to: ['bob@localhost'],
          subject: `Draft attachment ${marker}`,
          body: 'See attached',
          attachments: [{ path: file, filename: 'note.txt', contentType: 'text/plain' }],
        });

        const downloaded = await services.imapService.downloadAttachment(
          TEST_ACCOUNT_NAME,
          String(result.id),
          result.mailbox,
          'note.txt',
        );
        expect(Buffer.from(downloaded.contentBase64, 'base64').toString('utf8')).toBe(marker);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('should refuse a draft attachment path outside the working directory', async () => {
      const outside = path.join(os.tmpdir(), `mailoo-draft-outside-${Date.now()}.txt`);
      await fs.writeFile(outside, 'outside-marker');
      try {
        await expect(
          services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
            to: ['bob@localhost'],
            subject: 'Outside draft attachment',
            body: 'Should not save',
            attachments: [{ path: outside }],
          }),
        ).rejects.toThrow(/not allowed/);
      } finally {
        await fs.unlink(outside);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // send_draft
  // ---------------------------------------------------------------------------

  describe('sendDraft', () => {
    it('should send a saved draft and remove it', async () => {
      // First save a draft
      const draft = await services.imapService.saveDraft(TEST_ACCOUNT_NAME, {
        to: ['bob@localhost'],
        subject: 'Draft to send',
        body: 'This draft will be sent.',
      });

      // Send the draft
      const result = await services.smtpService.sendDraft(
        TEST_ACCOUNT_NAME,
        draft.id,
        draft.mailbox,
      );

      expect(result.messageId).toBeTruthy();

      await waitForDelivery();
    });
  });
});
