import { Readable } from 'node:stream';

import {
  attachmentNode,
  mixedStructure,
  singlePartAttachment,
  twinAttachmentStructure,
  withoutPartNumbers,
} from '../test-support/imap-bodystructure.js';
import {
  createMockConnectionManager,
  createMockImapClient,
  downloadReturnsPartName,
  fetchOneByUid,
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

  describe('downloadAttachment', () => {
    it('should reject a filename two attachments share and list their MIME parts', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt'),
      });
      downloadReturnsPartName(client);

      await expect(service.downloadAttachment('test', '9', 'INBOX', 'a.txt')).rejects.toThrow(
        'Attachment name "a.txt" matches 2 attachments in email 9 (MIME parts 2, 3)',
      );
    });

    it.each([
      { structure: twinAttachmentStructure('a.txt', 'b.txt'), available: 'a.txt, b.txt' },
      { structure: mixedStructure(), available: 'none' },
    ])(
      'should list the available attachments ($available) when no attachment has the name',
      async ({ structure, available }) => {
        fetchOneByUid(client, { uid: 9, bodyStructure: structure });
        downloadReturnsPartName(client);

        await expect(service.downloadAttachment('test', '9', 'INBOX', 'c.txt')).rejects.toThrow(
          `Attachment "c.txt" not found. Available: ${available}`,
        );
      },
    );

    it('should say the email is not in the mailbox when fetchOne finds no message', async () => {
      fetchOneByUid(client, { uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') });
      downloadReturnsPartName(client);

      await expect(service.downloadAttachment('test', '8', 'INBOX', 'a.txt')).rejects.toThrow(
        'Email 8 not found in INBOX',
      );
    });

    // Content-Disposition: attachment with no parameters; the name is then
    // only in the Content-Type name parameter.
    it('should find an attachment by its Content-Type name when the disposition has no parameters', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'a.pdf', {
            type: 'application/pdf',
            dispositionParameters: undefined,
          }),
        ),
      });
      downloadReturnsPartName(client);

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'a.pdf');

      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-2');
    });

    it('should download the MIME part of a filename that matches once', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: twinAttachmentStructure('a.txt', 'b.txt'),
      });
      downloadReturnsPartName(client);

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-3');
    });

    // The size is what was downloaded, not the encoded BODYSTRUCTURE size (16 here).
    it('should return the size of the downloaded content', async () => {
      fetchOneByUid(client, { uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') });
      downloadReturnsPartName(client);

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(result.size).toBe('body-of-part-3'.length);
    });

    // A large part arrives as many stream chunks; the GreenMail fixtures arrive as one.
    it('should return every chunk of a part delivered in several chunks', async () => {
      fetchOneByUid(client, { uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') });
      client.download.mockResolvedValue({
        meta: { contentType: 'text/plain' },
        content: Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
      });

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(result.contentBase64).toBe('YWJjZA==');
    });

    // imapflow numbers every child part. A structure that arrives without those
    // numbers must be numbered the same way, or the download reads another part.
    it('should number attachment parts by position when the structure has none', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: withoutPartNumbers(twinAttachmentStructure('a.txt', 'b.txt')),
      });
      downloadReturnsPartName(client);

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-3');
    });

    it('should number a nested attachment by its dotted path when the structure has none', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: withoutPartNumbers({
          type: 'multipart/mixed',
          childNodes: [
            {
              type: 'multipart/related',
              childNodes: [
                { part: '1.1', type: 'text/html', encoding: '7bit', size: 40, lineCount: 1 },
                attachmentNode('1.2', 'logo.png', { type: 'image/png' }),
              ],
            },
            attachmentNode('2', 'terms.pdf', { type: 'application/pdf' }),
          ],
        }),
      });
      downloadReturnsPartName(client);

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'logo.png');

      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-1.2');
    });

    it('should refuse an attachment a byte over the size limit', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(attachmentNode('2', 'big.txt', { size: 17 })),
      });
      downloadReturnsPartName(client);

      await expect(service.downloadAttachment('test', '9', 'INBOX', 'big.txt', 16)).rejects.toThrow(
        /exceeds/,
      );
    });

    it('should download an attachment exactly at the size limit', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(attachmentNode('2', 'edge.txt', { size: 16 })),
      });
      downloadReturnsPartName(client);

      const result = await service.downloadAttachment('test', '9', 'INBOX', 'edge.txt', 16);

      expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-2');
    });

    // An empty part number downloads BODY[], the whole message, as the attachment.
    it('should refuse a single-part attachment that has no MIME part number', async () => {
      fetchOneByUid(client, { uid: 9, bodyStructure: singlePartAttachment });
      downloadReturnsPartName(client);

      await expect(service.downloadAttachment('test', '9', 'INBOX', 'a.pdf')).rejects.toThrow(
        'Could not locate MIME part for "a.pdf"',
      );
    });

    // imapflow's download resolves {} when it gets no body back for the part.
    it('should say the download failed when the part has no content', async () => {
      fetchOneByUid(client, { uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') });
      client.download.mockResolvedValue({});

      await expect(service.downloadAttachment('test', '9', 'INBOX', 'b.txt')).rejects.toThrow(
        'Failed to download attachment "b.txt"',
      );
    });

    // A lock left held makes every later call on the account wait out the lock timeout.
    it('should release the mailbox lock once after downloading', async () => {
      fetchOneByUid(client, { uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') });
      downloadReturnsPartName(client);

      await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });
});
