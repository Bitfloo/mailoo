import { inspect } from 'node:util';

import type { SmtpAuth } from '../connections/auth.js';
import { MAX_ERROR_TEXT_LENGTH } from '../connections/credential-redaction.js';
import ConnectionManager from '../connections/manager.js';
import {
  createMockConnectionManager,
  createMockImapService,
  createMockRateLimiter,
  createMockTransport,
} from '../test-support/smtp-harness.js';
import type { AccountConfig } from '../types/index.js';
import SmtpService from './smtp.service.js';

const h = vi.hoisted(() => ({ verifyError: null as Error | null }));

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

const oauthAccount: AccountConfig = {
  ...passwordAccount,
  password: undefined,
  oauth2: {
    provider: 'google',
    clientId: 'fake-client-id',
    clientSecret: 'fake-client-secret',
    refreshToken: 'fake-refresh-token',
  },
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
    const manager = new ConnectionManager([oauthAccount], {
      getAccessToken: async () => ACCESS_TOKEN,
    });
    const service = new SmtpService(manager, createMockRateLimiter(true), createMockImapService());
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 Token [redacted] is not valid',
    );
  });

  it('should redact with the secrets of the account the mail is sent from', async () => {
    h.verifyError = eauth('535 5.7.8 0ther-Pa55word! rejected');
    const other: AccountConfig = {
      ...passwordAccount,
      name: 'other',
      email: 'other@example.com',
      username: 'other@example.com',
      password: '0ther-Pa55word!',
    };
    const manager = new ConnectionManager([passwordAccount, other], undefined, 'test');
    const service = new SmtpService(manager, createMockRateLimiter(true), createMockImapService());
    await expect(service.sendEmail('other', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 [redacted] rejected',
    );
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
