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
  rejectCommandsDuringFetch,
} from '../test-support/imap-client-fake.js';
import ImapService, { decodedBase64Size } from './imap.service.js';

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  // imapflow sets dispositionParameters whenever Content-Disposition carries any
  // parameter, so a lone size= must not hide the name in the Content-Type.
  const dispositionsWithoutFilename = [
    { label: 'only a size parameter', dispositionParameters: { size: '16' } },
    { label: 'an empty parameter list', dispositionParameters: {} },
  ];

  describe('peekAttachments', () => {
    it.each(dispositionsWithoutFilename)(
      'should name an attachment by its Content-Type name when the disposition has $label',
      async ({ dispositionParameters }) => {
        fetchOneByUid(client, {
          uid: 9,
          bodyStructure: mixedStructure(
            attachmentNode('2', 'a.pdf', { type: 'application/pdf', dispositionParameters }),
          ),
        });

        const attachments = await service.peekAttachments('test', '9', 'INBOX');

        expect(attachments).toEqual([{ filename: 'a.pdf', mime: 'application/pdf' }]);
      },
    );

    // RFC 2183 defines filename on Content-Disposition; some mailers repeat one in the Content-Type.
    it('should prefer the disposition filename over a Content-Type filename', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'report.pdf', {
            type: 'application/pdf',
            parameters: { filename: 'scan-0042.pdf' },
          }),
        ),
      });

      const attachments = await service.peekAttachments('test', '9', 'INBOX');

      expect(attachments).toEqual([{ filename: 'report.pdf', mime: 'application/pdf' }]);
    });

    it('should name an attachment unnamed when neither header carries a name', async () => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(
          attachmentNode('2', 'a.pdf', {
            type: 'application/pdf',
            parameters: undefined,
            dispositionParameters: undefined,
          }),
        ),
      });

      const attachments = await service.peekAttachments('test', '9', 'INBOX');

      expect(attachments).toEqual([{ filename: 'unnamed', mime: 'application/pdf' }]);
    });
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

    it.each(dispositionsWithoutFilename)(
      'should find an attachment by its Content-Type name when the disposition has $label',
      async ({ dispositionParameters }) => {
        fetchOneByUid(client, {
          uid: 9,
          bodyStructure: mixedStructure(
            attachmentNode('2', 'a.pdf', { type: 'application/pdf', dispositionParameters }),
          ),
        });
        downloadReturnsPartName(client);

        const result = await service.downloadAttachment('test', '9', 'INBOX', 'a.pdf');

        expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('body-of-part-2');
      },
    );

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

    it.each([
      ['refuse an attachment a byte over', 5 * 1024 * 1024 + 1, false],
      ['download an attachment exactly at', 5 * 1024 * 1024, true],
    ])('should %s the 5 MiB default cap', async (_, size, allowed) => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(attachmentNode('2', 'scan.pdf', { size })),
      });
      downloadReturnsPartName(client);

      const download = service.downloadAttachment('test', '9', 'INBOX', 'scan.pdf');

      await (allowed
        ? expect(download).resolves.toMatchObject({ filename: 'scan.pdf' })
        : expect(download).rejects.toThrow('exceeds 5MB'));
    });

    // The cap bounds the base64 response, so it compares the size the server reports. Were it
    // to switch to the decoded estimate, 5 MiB + 1 encoded bytes would pass as about 3.6 MB.
    it.each([
      [
        '5 MiB + 1 byte',
        5 * 1024 * 1024 + 1,
        'Attachment "scan.pdf" is 5MB encoded, exceeds 5MB limit',
      ],
      ['17 MiB', 17 * 1024 * 1024, 'Attachment "scan.pdf" is 17MB encoded, exceeds 5MB limit'],
      // 5.38 MiB: round and floor say 5, ceil says 6.
      [
        '5 MiB + 400000 bytes',
        5 * 1024 * 1024 + 400_000,
        'Attachment "scan.pdf" is 5MB encoded, exceeds 5MB limit',
      ],
      // 5.57 MiB: round and ceil say 6, floor says 5.
      [
        '5 MiB + 600000 bytes',
        5 * 1024 * 1024 + 600_000,
        'Attachment "scan.pdf" is 6MB encoded, exceeds 5MB limit',
      ],
    ])('should name the encoded size in the refusal of %s', async (_, size, message) => {
      fetchOneByUid(client, {
        uid: 9,
        bodyStructure: mixedStructure(attachmentNode('2', 'scan.pdf', { size })),
      });
      downloadReturnsPartName(client);

      await expect(
        service.downloadAttachment('test', '9', 'INBOX', 'scan.pdf'),
      ).rejects.toMatchObject({ message });
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

    // imapflow runs one command at a time: a command sent inside an open FETCH never starts.
    it('should issue no command while a FETCH is open', async () => {
      const message = { uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') };
      fetchOneByUid(client, message);
      downloadReturnsPartName(client);
      const issuedDuringFetch = rejectCommandsDuringFetch(client, [message]);

      await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(issuedDuringFetch).toEqual([]);
    });

    // A lock left held makes every later call on the account wait out the lock timeout.
    it('should release the mailbox lock once after downloading', async () => {
      fetchOneByUid(client, { uid: 9, bodyStructure: twinAttachmentStructure('a.txt', 'b.txt') });
      downloadReturnsPartName(client);

      await service.downloadAttachment('test', '9', 'INBOX', 'b.txt');

      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('getEmail attachment sizes', () => {
    const REPORTED_BASE64_SIZE = 273_684;
    const DECODED_SIZE = 200_000;

    async function attachmentsOf(...nodes: object[]) {
      fetchOneByUid(client, {
        uid: 9,
        envelope: { subject: 'Sizes', from: [{ address: 'sender@example.com' }] },
        flags: new Set<string>(),
        bodyStructure: mixedStructure(...nodes),
      });
      downloadReturnsPartName(client);
      return (await service.getEmail('test', '9')).attachments;
    }

    // BODYSTRUCTURE of the 200000-byte file GreenMail received from nodemailer.
    const greenMailBin = () =>
      attachmentNode('2', 'próbka-ąę.bin', {
        type: 'application/octet-stream',
        size: REPORTED_BASE64_SIZE,
      });

    it('should report the decoded size of a base64 attachment and flag it as an estimate', async () => {
      const attachments = await attachmentsOf(greenMailBin());

      expect(attachments).toStrictEqual([
        {
          filename: 'próbka-ąę.bin',
          mimeType: 'application/octet-stream',
          size: DECODED_SIZE,
          sizeIsEstimate: true,
        },
      ]);
    });

    it('should keep the reported size, without an estimate flag, for 7bit and quoted-printable parts', async () => {
      const attachments = await attachmentsOf(
        greenMailBin(),
        attachmentNode('3', 'notes.txt', { encoding: '7bit', size: 34 }),
        attachmentNode('4', 'quoted.txt', { encoding: 'quoted-printable', size: 2048 }),
      );

      expect(attachments).toStrictEqual([
        {
          filename: 'próbka-ąę.bin',
          mimeType: 'application/octet-stream',
          size: DECODED_SIZE,
          sizeIsEstimate: true,
        },
        { filename: 'notes.txt', mimeType: 'text/plain', size: 34 },
        { filename: 'quoted.txt', mimeType: 'text/plain', size: 2048 },
      ]);
    });

    // imapflow leaves `encoding` unset for a NIL BODYSTRUCTURE field, and RFC 2045 section 6.1
    // makes 7bit the default, so the reported size is already the decoded size.
    it('should keep the reported size, without an estimate flag, for an attachment with no transfer encoding', async () => {
      const node = attachmentNode('2', 'plain.txt', { size: 2048 });
      const nodeWithoutEncoding = Object.fromEntries(
        Object.entries(node).filter(([key]) => key !== 'encoding'),
      );

      const attachments = await attachmentsOf(nodeWithoutEncoding);

      expect(attachments).toStrictEqual([
        { filename: 'plain.txt', mimeType: 'text/plain', size: 2048 },
      ]);
    });

    // Only base64 inflates a part by a fixed factor. A guard that matched "not 7bit" would shrink these.
    it.each(['8bit', 'binary', 'quoted-printable'])(
      'should keep the reported size without an estimate flag for an attachment encoded as %s',
      async (encoding) => {
        const attachments = await attachmentsOf(
          attachmentNode('2', 'raw.dat', { encoding, size: 2048 }),
        );

        expect(attachments).toStrictEqual([
          { filename: 'raw.dat', mimeType: 'text/plain', size: 2048 },
        ]);
      },
    );
  });
});

// Mail clients wrap base64 at 76 characters and end each line with CRLF (RFC 2045 section 6.8),
// so every 57 decoded bytes occupy 78 octets in the part BODYSTRUCTURE sizes.
describe('decodedBase64Size', () => {
  /**
   * Measured, not derived: for every n in 1..20000, decodedBase64Size(S) - n is in -1..2
   * when S is the 76-column CRLF-wrapped length without a trailing CRLF (what nodemailer
   * writes) and in 0..3 with one. 3 is the widest observed error and no wider: n = 1 with
   * a trailing CRLF gives S = 6, which rounds to 4 (error 3) but would ceil to 5.
   */
  const ESTIMATE_TOLERANCE_BYTES = 3;

  /** Matches nodemailer's body byte for byte for the sizes below (measured against its MIME output). */
  function mimeBase64Length(content: Buffer, trailingCrlf: boolean): number {
    const wrapped = content.toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
    return Buffer.byteLength(trailingCrlf ? `${wrapped}\r\n` : wrapped);
  }

  const bytesOf = (n: number) =>
    Buffer.from(Uint8Array.from({ length: n }, (_, i) => (i * 131 + 7) % 256));

  const cases = [1, 2, 3, 57, 58, 200_000].flatMap((n) => [
    { n, trailingCrlf: false, label: 'without' },
    { n, trailingCrlf: true, label: 'with' },
  ]);

  it.each(cases)(
    'should estimate $n decoded bytes within tolerance from a 76-column body $label a trailing CRLF',
    ({ n, trailingCrlf }) => {
      const encoded = mimeBase64Length(bytesOf(n), trailingCrlf);

      expect(Math.abs(decodedBase64Size(encoded) - n)).toBeLessThanOrEqual(
        ESTIMATE_TOLERANCE_BYTES,
      );
    },
  );

  it.each([
    ['the size GreenMail reports for 200000 bytes sent by nodemailer', 273_684, 200_000],
    ['base64 written without line breaks, which comes out low', 266_668, 194_873],
    ['a fraction above one half, rounded up', 76, 56],
    ['a fraction below one half, rounded down', 80, 58],
    ['an empty part', 0, 0],
  ])('should map %s: %i encoded to %i decoded', (_, encoded, decoded) => {
    expect(decodedBase64Size(encoded)).toBe(decoded);
  });
});
