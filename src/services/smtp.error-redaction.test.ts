import fs from 'node:fs/promises';
import { inspect } from 'node:util';

import type { SmtpAuth } from '../connections/auth.js';
import { MAX_ERROR_TEXT_LENGTH } from '../connections/credential-redaction.js';
import ConnectionManager from '../connections/manager.js';
import { SchedulerService, withDueQueue } from '../test-support/scheduler-fixtures.js';
import {
  createMockConnectionManager,
  createMockImapService,
  createMockRateLimiter,
  createMockTransport,
} from '../test-support/smtp-harness.js';
import type { AccountConfig, ScheduledEmail } from '../types/index.js';
import SmtpService from './smtp.service.js';

const h = vi.hoisted(() => ({
  verifyError: null as Error | null,
  sendError: null as Error | null,
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

// The transport the real connection manager builds: nodemailer asks for the token while it
// authenticates, then the server answers.
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: { auth: SmtpAuth }) => ({
      verify: async () => {
        const { auth } = options;
        if ('provisionCallback' in auth) {
          await new Promise<void>((resolve, reject) => {
            auth.provisionCallback(auth.user, false, (err) => (err ? reject(err) : resolve()));
          });
        }
        if (h.verifyError) throw h.verifyError;
        return true;
      },
      sendMail: async () => {
        if (h.sendError) throw h.sendError;
        return { messageId: '<sent@example.com>' };
      },
      close: vi.fn(),
    }),
  },
}));

const ACCESS_TOKEN = 'ya29.fake-access-token-0123456789';

const passwordAccount: AccountConfig = {
  name: 'test',
  email: 'test@example.com',
  username: 'test@example.com',
  password: 'S3cret-Pa55word!',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

// A fresh oauth2 object per test: the issued token is recorded against it, and a token left by
// one connect would let the other pass without recording its own.
function oauthAccount(): AccountConfig {
  return {
    ...passwordAccount,
    password: undefined,
    oauth2: {
      provider: 'google',
      clientId: 'fake-client-id',
      clientSecret: 'fake-client-secret',
      refreshToken: 'fake-refresh-token',
    },
  };
}

const otherAccount: AccountConfig = {
  ...passwordAccount,
  name: 'other',
  email: 'other@example.com',
  username: 'other@example.com',
  password: '0ther-Pa55word!',
};

/** nodemailer's EAUTH shape: the server line in the message and in `response`. */
function eauth(reply: string): Error {
  return Object.assign(new Error(`Invalid login: ${reply}`), {
    code: 'EAUTH',
    response: reply,
    responseCode: 535,
    command: 'AUTH PLAIN',
  });
}

function serviceFor(account: AccountConfig) {
  const transport = createMockTransport();
  const connections = createMockConnectionManager(transport);
  connections.getAccount.mockReturnValue(account);
  const service = new SmtpService(
    connections,
    createMockRateLimiter(true),
    createMockImapService(),
  );
  return { transport, connections, service };
}

const mail = { to: ['recipient@example.com'], subject: 'Hello', body: 'World' };

beforeEach(() => {
  h.verifyError = null;
  h.sendError = null;
});

describe('SmtpService send errors', () => {
  it('should redact the password a 535 reply quotes when sending fails', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue(eauth('535 5.7.8 S3cret-Pa55word! rejected'));
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 [redacted] rejected',
    );
  });

  it('should redact the OAuth2 token the connection manager handed to nodemailer', async () => {
    h.verifyError = eauth(`535 5.7.8 Token ${ACCESS_TOKEN} is not valid`);
    const manager = new ConnectionManager([oauthAccount()], {
      getAccessToken: async () => ACCESS_TOKEN,
    });
    const service = new SmtpService(manager, createMockRateLimiter(true), createMockImapService());
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 Token [redacted] is not valid',
    );
  });

  // SmtpService redacts the error again with the token recorded by then, which would hide a
  // manager that read the account's secrets before verify() asked for the token.
  it('should redact the OAuth2 token in the error the connection manager rejects with', async () => {
    h.verifyError = eauth(`535 5.7.8 Token ${ACCESS_TOKEN} is not valid`);
    const manager = new ConnectionManager([oauthAccount()], {
      getAccessToken: async () => ACCESS_TOKEN,
    });
    await expect(manager.getSmtpTransport('test')).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 Token [redacted] is not valid',
    );
  });

  it('should redact a failed connect with the secrets of the account the mail is sent from', async () => {
    h.verifyError = eauth('535 5.7.8 0ther-Pa55word! rejected');
    const manager = new ConnectionManager([passwordAccount, otherAccount], undefined, 'test');
    const service = new SmtpService(manager, createMockRateLimiter(true), createMockImapService());
    await expect(service.sendEmail('other', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 [redacted] rejected',
    );
  });

  // sendMail() logs in on its own connection after verify() passed, so this refusal never reaches
  // the connection manager's catch.
  it('should redact a refused send with the secrets of the account the mail is sent from', async () => {
    h.sendError = eauth('535 5.7.8 0ther-Pa55word! rejected');
    const manager = new ConnectionManager([passwordAccount, otherAccount], undefined, 'test');
    const service = new SmtpService(manager, createMockRateLimiter(true), createMockImapService());
    await expect(service.sendEmail('other', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 [redacted] rejected',
    );
  });

  // verify() recorded the token, so only the send catch can redact sendMail()'s own refusal.
  it('should redact the OAuth2 token a refused send quotes', async () => {
    h.sendError = eauth(`535 5.7.8 Token ${ACCESS_TOKEN} is not valid`);
    const manager = new ConnectionManager([oauthAccount()], {
      getAccessToken: async () => ACCESS_TOKEN,
    });
    const service = new SmtpService(manager, createMockRateLimiter(true), createMockImapService());
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 Token [redacted] is not valid',
    );
  });

  it('should leave the OAuth2 token a refused send quotes nowhere on the error', async () => {
    h.sendError = eauth(`535 5.7.8 Token ${ACCESS_TOKEN} is not valid`);
    const manager = new ConnectionManager([oauthAccount()], {
      getAccessToken: async () => ACCESS_TOKEN,
    });
    const service = new SmtpService(manager, createMockRateLimiter(true), createMockImapService());
    await expect(service.sendEmail('test', mail)).rejects.toSatisfy(
      (err: unknown) => !inspect(err).includes(ACCESS_TOKEN),
    );
  });

  it('should redact the password a 535 reply quotes when replyToEmail fails', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue(eauth('535 5.7.8 S3cret-Pa55word! rejected'));
    await expect(
      service.replyToEmail('test', { emailId: '42', body: 'Thanks' }),
    ).rejects.toHaveProperty('message', 'Invalid login: 535 5.7.8 [redacted] rejected');
  });

  // `mailoo scheduler list` prints the error queued on the record.
  it('should queue a scheduled send refused by a 535 reply with the password redacted', async () => {
    await withDueQueue(async ({ queueDir, pendingPath }) => {
      const { transport, service } = serviceFor(passwordAccount);
      transport.sendMail.mockRejectedValue(eauth('535 5.7.8 S3cret-Pa55word! rejected'));
      await new SchedulerService(service, createMockImapService(), queueDir).checkAndSend();
      const queued = JSON.parse(await fs.readFile(pendingPath, 'utf8')) as ScheduledEmail;
      expect(queued.lastError).toBe('Invalid login: 535 5.7.8 [redacted] rejected');
    });
  });

  it('should redact the password a 535 reply quotes when the first connect fails', async () => {
    const { connections, service } = serviceFor(passwordAccount);
    connections.getSmtpTransport.mockRejectedValue(eauth('535 5.7.8 S3cret-Pa55word! rejected'));
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 [redacted] rejected',
    );
  });

  it('should redact a rejection that is not an Error', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue('535 5.7.8 S3cret-Pa55word! rejected');
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      '535 5.7.8 [redacted] rejected',
    );
  });

  it('should keep the SMTP error code, response code and command on the redacted error', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue(eauth('535 5.7.8 S3cret-Pa55word! rejected'));
    await expect(service.sendEmail('test', mail)).rejects.toMatchObject({
      code: 'EAUTH',
      responseCode: 535,
      command: 'AUTH PLAIN',
    });
  });

  it('should not carry the raw server response on the redacted error', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue(eauth('535 5.7.8 S3cret-Pa55word! rejected'));
    await expect(service.sendEmail('test', mail)).rejects.not.toHaveProperty('response');
  });

  it('should not chain the raw error as the cause', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue(eauth('535 5.7.8 S3cret-Pa55word! rejected'));
    await expect(service.sendEmail('test', mail)).rejects.not.toHaveProperty('cause');
  });

  // inspect() prints the stack and every own property, so a copied stack or field shows up here.
  it('should leave the password nowhere on the redacted error, stack included', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue(eauth('535 5.7.8 S3cret-Pa55word! rejected'));
    await expect(service.sendEmail('test', mail)).rejects.toSatisfy(
      (err: unknown) => !inspect(err).includes('S3cret-Pa55word!'),
    );
  });

  it('should cut a long send error to the cap', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue(new Error('x'.repeat(MAX_ERROR_TEXT_LENGTH * 2)));
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      `${'x'.repeat(MAX_ERROR_TEXT_LENGTH - 1)}…`,
    );
  });
});
