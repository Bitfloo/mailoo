import { mcpLog } from '../logging.js';
import type RateLimiter from '../safety/rate-limiter.js';
import {
  accountWithSmtp,
  createMockConnectionManager,
  createMockImapService,
  createMockRateLimiter,
  createMockTransport,
} from '../test-support/smtp-harness.js';
import SmtpService from './smtp.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let imap: ReturnType<typeof createMockImapService>;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    imap = createMockImapService();
    service = new SmtpService(connections, rateLimiter, imap);
  });

  describe('sendEmail', () => {
    it('appends a Sent copy after a successful send', async () => {
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });
      expect(imap.appendSentMessage).toHaveBeenCalledOnce();
    });

    it('still sends when Sent APPEND fails and exposes savedToSent: false', async () => {
      (imap.appendSentMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('NO [OVERQUOTA]'),
      );
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World-should-not-be-logged',
      });
      expect(result.status).toBe('sent');
      expect(result.messageId).toBe('<test@example.com>');
      expect(result.savedToSent).toBe(false);
      expect(mcpLog).toHaveBeenCalledWith(
        'warning',
        'smtp',
        expect.stringContaining('NO [OVERQUOTA]'),
      );
      const logData = vi
        .mocked(mcpLog)
        .mock.calls.map((call) => String(call[2]))
        .join('\n');
      expect(logData).not.toContain('World-should-not-be-logged');
    });

    it('skips Sent append for Gmail SMTP', async () => {
      connections.getAccount.mockReturnValue({
        name: 'test',
        email: 'user@example.com',
        username: 'user@example.com',
        imap: { host: 'imap.gmail.com', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
        oauth2: { provider: 'google' },
      });
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });
      expect(imap.appendSentMessage).not.toHaveBeenCalled();
    });

    it.each([
      'gmail.com',
      'smtp.gmail.com',
      'SMTP.GMAIL.COM',
      'googlemail.com',
      'smtp.googlemail.com',
      'mail.gmail.com',
      'GoogleMail.com',
      'mail.googlemail.com',
      'gmail.com.',
      'smtp.gmail.com.',
      ' gmail.com',
      'googlemail.com ',
    ])('skips Sent append when the SMTP host is %s', async (host) => {
      connections.getAccount.mockReturnValue(accountWithSmtp(host));
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });
      expect(imap.appendSentMessage).not.toHaveBeenCalled();
    });

    it.each([
      'gmail.com.evil.example',
      'notgmail.com',
      'gmail.com.attacker.test',
      'smtp.gmail.com.attacker.test',
      'gmail.comfoo',
      'xgmail.com',
      '.gmail.com',
      '.googlemail.com',
      'gmail.com.evil.example.',
      'notgmail.com.',
      '',
      '192.0.2.1',
      '[2001:db8::1]',
      'gmail.com@example.test',
      '@gmail.com',
      'gm\u0430il.com',
    ])('still appends Sent when the SMTP host only contains %s', async (host) => {
      connections.getAccount.mockReturnValue(accountWithSmtp(host));
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });
      expect(imap.appendSentMessage).toHaveBeenCalledOnce();
    });

    it('skips Sent append when the OAuth provider is google', async () => {
      connections.getAccount.mockReturnValue(accountWithSmtp('smtp.example.com', 'google'));
      await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });
      expect(imap.appendSentMessage).not.toHaveBeenCalled();
    });
  });
});
