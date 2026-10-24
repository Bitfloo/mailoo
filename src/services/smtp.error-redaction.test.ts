import type { SmtpAuth } from '../connections/auth.js';
import { buildSmtpAuth } from '../connections/auth.js';
import { MAX_ERROR_TEXT_LENGTH } from '../connections/credential-redaction.js';
import {
  createMockConnectionManager,
  createMockImapService,
  createMockRateLimiter,
  createMockTransport,
} from '../test-support/smtp-harness.js';
import type { AccountConfig } from '../types/index.js';
import SmtpService from './smtp.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
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

/** What nodemailer does during AUTH XOAUTH2: ask the provision callback for the token. */
async function provisionToken(auth: SmtpAuth): Promise<void> {
  if (!('provisionCallback' in auth)) throw new Error('expected an OAuth2 auth');
  await new Promise<void>((resolve, reject) => {
    auth.provisionCallback(auth.user, false, (err) => (err ? reject(err) : resolve()));
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

describe('SmtpService send errors', () => {
  it('should redact the password a 535 reply quotes when sending fails', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue(eauth('535 5.7.8 S3cret-Pa55word! rejected'));
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 [redacted] rejected',
    );
  });

  it('should redact the OAuth2 token handed to the transport when sending fails', async () => {
    const { transport, service } = serviceFor(oauthAccount);
    const auth = buildSmtpAuth(oauthAccount, { getAccessToken: async () => ACCESS_TOKEN });
    transport.sendMail.mockImplementation(async () => {
      await provisionToken(auth);
      throw eauth(`535 5.7.8 Token ${ACCESS_TOKEN} is not valid`);
    });
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      'Invalid login: 535 5.7.8 Token [redacted] is not valid',
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

  it('should cut a long send error to the cap', async () => {
    const { transport, service } = serviceFor(passwordAccount);
    transport.sendMail.mockRejectedValue(new Error('x'.repeat(MAX_ERROR_TEXT_LENGTH * 2)));
    await expect(service.sendEmail('test', mail)).rejects.toHaveProperty(
      'message',
      `${'x'.repeat(MAX_ERROR_TEXT_LENGTH - 1)}…`,
    );
  });
});
