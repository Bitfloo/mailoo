import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  attachmentNode,
  mixedStructure,
  singlePartAttachment,
  twinAttachmentStructure,
} from '../test-support/imap-bodystructure.js';
import {
  createMockConnectionManager,
  createMockImapClient,
  downloadReturnsPartName,
  fetchOneByUid,
  rejectCommandsDuringFetch,
} from '../test-support/imap-client-fake.js';
import ImapService, { SAVED_ATTACHMENT_MAX_BYTES } from './imap.service.js';

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  describe('saveEmailAttachments', () => {
    let root: string;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-save-unit-'));
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('should write each same-named attachment to its own file', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt'),
      });
      downloadReturnsPartName(client);
      const destDir = path.join(root, 'out');

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);

      const contents = await Promise.all(saved.map(async (s) => fs.readFile(s.localPath, 'utf-8')));
      expect(contents.sort()).toEqual(['body-of-part-2', 'body-of-part-3']);
    });

    it.each([
      ['../../evil.txt', 'evil.txt'],
      ['..\\..\\evil.txt', 'evil.txt'],
      ['..', 'attachment'],
      ['.bashrc', 'bashrc'],
    ])('should keep attachment %j inside the destination as %j', async (filename, expected) => {
      const structure = twinAttachmentStructure(filename);
      structure.childNodes.pop();
      fetchOneByUid(client, { uid: 9, bodyStructure: structure });
      downloadReturnsPartName(client);
      const destDir = path.join(root, 'a', 'b');

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);

      expect(saved.map((s) => path.relative(destDir, s.localPath))).toEqual([expected]);
    });

    // The size is what was written, not the encoded BODYSTRUCTURE size (16 here).
    it('should return the filename, MIME type, written size and file URL', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(attachmentNode('2', 'notes.txt')),
      });
      downloadReturnsPartName(client);
      const destDir = path.join(root, 'out');
      const localPath = path.join(destDir, 'notes.txt');

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);

      expect(saved).toEqual([
        {
          filename: 'notes.txt',
          localPath,
          fileUrl: `file://${localPath}`,
          mimeType: 'text/plain',
          size: 'body-of-part-2'.length,
        },
      ]);
    });

    it('should save an attachment at the size limit and skip one a byte over it', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'at-limit.txt', { size: 16 }),
          attachmentNode('3', 'over-limit.txt', { size: 17 }),
        ),
      });
      downloadReturnsPartName(client);

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root, 16);

      expect(saved.map((s) => s.filename)).toEqual(['at-limit.txt']);
    });

    // The calendar paths call this without a limit; docs/tools.md states the default.
    it('should skip an attachment a byte over the default limit and save one at it', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'at.bin', { size: SAVED_ATTACHMENT_MAX_BYTES }),
          attachmentNode('3', 'over.bin', { size: SAVED_ATTACHMENT_MAX_BYTES + 1 }),
        ),
      });
      downloadReturnsPartName(client);

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(saved.map((s) => s.filename)).toEqual(['at.bin']);
    });

    // Calendar data goes to the calendar, not to the attachment folder. nodemailer
    // and Gmail attach invite.ics as application/ics; a text/calendar part may have any name.
    it('should not write an invite.ics or text/calendar attachment', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'notes.txt'),
          attachmentNode('3', 'invite.ics', { type: 'application/ics', size: 434 }),
          attachmentNode('4', 'meeting', { type: 'text/calendar' }),
        ),
      });
      downloadReturnsPartName(client);

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(saved.map((s) => s.filename)).toEqual(['notes.txt']);
    });

    it('should save the other attachments when one part fails to download', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt', 'b.txt'),
      });
      downloadReturnsPartName(client);
      const byPartName = client.download.getMockImplementation();
      client.download.mockImplementation(async (uid: string, part: string, options?: object) => {
        if (part === '2') throw new Error('Command failed: NO [UNAVAILABLE]');
        return byPartName?.(uid, part, options);
      });

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(saved.map((s) => s.filename)).toEqual(['b.txt']);
    });

    // An empty part number downloads BODY[], the whole message, as the attachment.
    it('should neither download nor save a single-part attachment with no MIME part number', async () => {
      fetchOneByUid(client, { uid: 9, bodyStructure: singlePartAttachment });
      downloadReturnsPartName(client);

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(saved).toEqual([]);
      expect(client.download).not.toHaveBeenCalled();
    });

    // APFS and NTFS are case-insensitive by default: "A.txt" would overwrite "a.txt".
    it.each([
      ['a.txt', 'A.txt', ['a.txt', 'A-2.txt']],
      ['A.txt', 'a.txt', ['A.txt', 'a-2.txt']],
    ])(
      'should give %s and then %s separate files though they differ only in case',
      async (first, second, expected) => {
        fetchOneByUid(client, { uid: 9, bodyStructure: twinAttachmentStructure(first, second) });
        downloadReturnsPartName(client);

        const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root);

        expect(saved.map((s) => path.basename(s.localPath))).toEqual(expected);
      },
    );

    // The arrival hook saves the attachments of every invite; one with nothing
    // else attached must not leave an empty folder behind.
    it('should not create the destination when no attachment qualifies', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'invite.ics', { type: 'application/ics', size: 434 }),
        ),
      });
      downloadReturnsPartName(client);
      const destDir = path.join(root, 'out');

      await service.saveEmailAttachments('test', '9', 'INBOX', destDir);

      await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('should issue no command while a FETCH is open', async () => {
      const message = { uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') };
      fetchOneByUid(client, message);
      downloadReturnsPartName(client);
      const issuedDuringFetch = rejectCommandsDuringFetch(client, [message]);

      await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(issuedDuringFetch).toEqual([]);
    });

    // A lock left held makes every later call on the account wait out the lock timeout.
    // imapflow's fetchOne answers false for a UID the mailbox does not hold, and
    // undefined once the connection has dropped and no mailbox is selected.
    it.each([false, undefined])('should save nothing when fetchOne returns %s', async (missing) => {
      client.fetchOne.mockResolvedValue(missing);

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(saved).toEqual([]);
    });

    it('should release the mailbox lock once after saving', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt', 'b.txt'),
      });
      downloadReturnsPartName(client);

      await service.saveEmailAttachments('test', '9', 'INBOX', root);

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });
});
