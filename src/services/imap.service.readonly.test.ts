import {
  createMockConnectionManager,
  createMockImapClient,
  rejectCommandsDuringFetch,
} from '../test-support/imap-client-fake.js';
import ImapService from './imap.service.js';
import { MAILBOX_LOCK_TIMEOUT_MS } from './mailbox-lock.js';

describe('ImapService', () => {
  let client: ReturnType<typeof createMockImapClient>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let service: ImapService;

  beforeEach(() => {
    client = createMockImapClient();
    connections = createMockConnectionManager(client);
    service = new ImapService(connections);
  });

  describe('peekText', () => {
    it('uses a readOnly lock and does not fetch source', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        bodyStructure: { type: 'text/plain', part: '1' },
      });
      async function* chunksOf(text: string) {
        yield Buffer.from(text);
      }
      client.download.mockResolvedValue({ content: chunksOf('hello') });

      const text = await service.peekText('test', '10', 'INBOX');

      expect(text).toBe('hello');
      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', {
        readOnly: true,
        acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      });
      expect(client.fetchOne).toHaveBeenCalledWith(
        '10',
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      const query = client.fetchOne.mock.calls[0][1];
      expect(query).not.toHaveProperty('source');
    });
  });

  describe('peekAttachments', () => {
    it('uses a readOnly lock and does not fetch source', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        bodyStructure: { type: 'text/plain', part: '1' },
      });

      await service.peekAttachments('test', '10', 'INBOX');

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', {
        readOnly: true,
        acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      });
      expect(client.fetchOne).toHaveBeenCalledWith(
        '10',
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      const query = client.fetchOne.mock.calls[0][1];
      expect(query).not.toHaveProperty('source');
    });

    it('should return attachment filename and mime from bodyStructure', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        bodyStructure: {
          type: 'multipart/mixed',
          childNodes: [
            { type: 'text/plain', part: '1' },
            {
              part: '2',
              type: 'application/pdf',
              disposition: 'attachment',
              dispositionParameters: { filename: 'inv.pdf' },
            },
          ],
        },
      });

      const attachments = await service.peekAttachments('test', '10', 'INBOX');

      expect(attachments).toEqual([{ filename: 'inv.pdf', mime: 'application/pdf' }]);
    });
  });

  describe('exportEmail', () => {
    // BODY.PEEK[] already avoids \Seen on GreenMail, so only this lock stops a
    // server that ignores PEEK from changing flags.
    it('should open the mailbox read-only (EXAMINE) before fetching the source', async () => {
      client.fetchOne.mockImplementation(async (_uid: string, query: { source?: unknown }) => {
        if (query.source) return { uid: 10, source: Buffer.from('raw') };
        return { uid: 10, size: 3 };
      });

      await service.exportEmail('test', '10', 'Archive', 1024);

      expect(client.getMailboxLock).toHaveBeenCalledWith('Archive', {
        readOnly: true,
        acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      });
      expect(client.getMailboxLock).toHaveBeenCalledTimes(1);
    });

    it('should report the UID as not found when the server returns no message', async () => {
      client.fetchOne.mockResolvedValue(false);

      await expect(service.exportEmail('test', '10', 'INBOX', 1024)).rejects.toThrow(
        'Email 10 not found in INBOX',
      );
    });

    // imapflow runs one command at a time: a command sent inside an open FETCH never starts.
    it('should issue no command while a FETCH is open', async () => {
      const message = { uid: 10, size: 3, source: Buffer.from('raw') };
      client.fetchOne.mockResolvedValue(message);
      const issuedDuringFetch = rejectCommandsDuringFetch(client, [message]);

      await service.exportEmail('test', '10', 'INBOX', 1024);

      expect(issuedDuringFetch).toEqual([]);
    });

    it('should release the mailbox lock when the export fails', async () => {
      client.fetchOne.mockResolvedValue({ uid: 10, size: 99 });

      await expect(service.exportEmail('test', '10', 'INBOX', 10)).rejects.toThrow(/limit/);
      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('getEmailSecurity', () => {
    const foldedAuthHeaders = [
      'From: Brand <noreply@brand.example>',
      'Reply-To: support@brand.example',
      'Return-Path: <bounce@mail.brand.example>',
      'Authentication-Results: mx.google.com;',
      '       spf=pass smtp.mailfrom=noreply@brand.example;',
      '       dkim=pass header.d=brand.example header.s=s1;',
      '       dkim=pass header.d=mailer.example;',
      '       dmarc=pass header.from=brand.example',
      'List-Unsubscribe: <https://brand.example/unsub?token=secret>',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      '',
    ].join('\r\n');

    it('parses fetched headers into SPF/DKIM/DMARC without returning unsubscribe URLs', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        envelope: {},
        headers: Buffer.from(foldedAuthHeaders),
      });

      const signals = await service.getEmailSecurity('test', '10', 'INBOX');

      expect(signals.uid).toBe('10');
      expect(signals.mailbox).toBe('INBOX');
      expect(signals.fromDomain).toBe('brand.example');
      expect(signals.spf).toBe('pass');
      expect(signals.dmarc).toBe('pass');
      expect(signals.dkim).toEqual([
        { result: 'pass', domain: 'brand.example' },
        { result: 'pass', domain: 'mailer.example' },
      ]);
      expect(signals.hasListUnsubscribe).toBe(true);
      expect(JSON.stringify(signals)).not.toContain('https://brand.example/unsub');
    });

    it('uses a readOnly lock and fetches headers without source', async () => {
      client.fetchOne.mockResolvedValue({
        uid: 10,
        envelope: {},
        headers: Buffer.from('From: a@b.example\r\n\r\n'),
      });

      await service.getEmailSecurity('test', '10', 'INBOX');

      expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', {
        readOnly: true,
        acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
      });
      expect(client.fetchOne).toHaveBeenCalledWith(
        '10',
        { uid: true, envelope: true, headers: true },
        { uid: true },
      );
      expect(client.fetchOne.mock.calls[0][1]).not.toHaveProperty('source');
    });

    it('releases the mailbox lock when the message is missing', async () => {
      client.fetchOne.mockResolvedValue(false);

      await expect(service.getEmailSecurity('test', '99', 'INBOX')).rejects.toThrow(
        /Email 99 not found in INBOX/,
      );
      expect(client._releaseFn).toHaveBeenCalledTimes(1);
    });
  });
});
