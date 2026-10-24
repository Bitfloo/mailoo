import type { AccountConfig } from '../types/index.js';
import type { SmtpAuth } from './auth.js';
import { MAX_ERROR_TEXT_LENGTH } from './credential-redaction.js';
import { testImap, testSmtp } from './probe.js';
import type { AccessTokenSource } from './types.js';

const h = vi.hoisted(() => ({
  connectError: null as Error | null,
  // A socket error after login: imapflow emits it from the socket's handler, then the pending
  // command fails because the connection is gone.
  socketError: null as Error | null,
  // What emit('error') threw. In imapflow that throw leaves a socket callback, so it would be an
  // uncaught exception that ends the process.
  uncaught: [] as unknown[],
  verifyError: null as Error | string | null,
  // Folders whose STATUS the server refuses, as for a mailbox that does not exist.
  missing: new Set<string>(),
  // Folders LIST still shows whose STATUS the server refuses: imapflow 2 resolves false for them.
  refused: new Set<string>(),
  logout: vi.fn(async () => {}),
  close: vi.fn(),
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

// A Gmail-style account: the folders hang under [Gmail]/ and their counts differ.
vi.mock('imapflow', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    ImapFlow: class extends EventEmitter {
      // eslint-disable-next-line class-methods-use-this
      async connect(): Promise<void> {
        if (h.connectError) throw h.connectError;
      }

      async list(): Promise<{ path: string }[]> {
        const { socketError } = h;
        if (!socketError) return [{ path: '[Gmail]/All Mail' }, { path: '[Gmail]/Sent Mail' }];
        return new Promise((_resolve, reject) => {
          setImmediate(() => {
            try {
              this.emit('error', socketError);
            } catch (thrown) {
              h.uncaught.push(thrown);
            }
            reject(new Error('Connection not available'));
          });
        });
      }

      // eslint-disable-next-line class-methods-use-this
      async status(path: string): Promise<{ messages: number } | false> {
        if (h.missing.has(path)) {
          throw Object.assign(new Error('Command failed'), { serverResponseCode: 'NONEXISTENT' });
        }
        if (h.refused.has(path)) return false;
        return { messages: path === 'INBOX' ? 12 : 1834 };
      }

      // eslint-disable-next-line class-methods-use-this
      async logout(): Promise<void> {
        await h.logout();
      }
    },
  };
});

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: { auth: SmtpAuth }) => ({
      verify: async () => {
        // nodemailer asks for the token while it authenticates, before the server answers.
        const { auth } = options;
        if ('provisionCallback' in auth) {
          await new Promise<void>((resolve, reject) => {
            auth.provisionCallback(auth.user, false, (err) => (err ? reject(err) : resolve()));
          });
        }
        // A string stands for a library that rejects with something other than an Error.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (h.verifyError) throw h.verifyError;
        return true;
      },
      close: h.close,
    }),
  },
}));

const account: AccountConfig = {
  name: 'work',
  email: 'work@example.com',
  username: 'work@example.com',
  password: 'wrong-password',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

const ACCESS_TOKEN = 'ya29.fake-access-token-0123456789';

// A fresh oauth2 object per test: the issued token is recorded against it, and a token left by
// one probe would let the other pass without recording its own.
function oauthAccount(): AccountConfig {
  return {
    ...account,
    password: undefined,
    oauth2: {
      provider: 'google',
      clientId: 'fake-client-id',
      clientSecret: 'fake-client-secret',
      refreshToken: 'fake-refresh-token',
    },
  };
}

const tokens: AccessTokenSource = { getAccessToken: async () => ACCESS_TOKEN };

// imapflow 2's refused LOGIN or AUTHENTICATE: a generic message, the tagged reply as text in
// `response` and its human-readable part in `responseText`.
function imapflowRefusal(secret: string): Error {
  return Object.assign(new Error('Command failed'), {
    response: `2 NO [AUTHENTICATIONFAILED] ${secret} rejected`,
    responseStatus: 'NO',
    responseText: `${secret} rejected`,
    serverResponseCode: 'AUTHENTICATIONFAILED',
    authenticationFailed: true,
  });
}

beforeEach(() => {
  h.connectError = null;
  h.socketError = null;
  h.uncaught = [];
  h.verifyError = null;
  h.missing.clear();
  h.refused.clear();
  h.logout.mockClear();
  h.close.mockClear();
});

describe('testImap', () => {
  it('should report the refused login and still log out', async () => {
    // imapflow's shape for a refused LOGIN: a generic message, the reason in the fields.
    h.connectError = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      serverResponseCode: 'AUTHENTICATIONFAILED',
      response: 'Invalid credentials (Failure)',
    });
    expect(await testImap(account)).toEqual({ success: false, error: 'Command failed' });
    expect(h.logout).toHaveBeenCalledOnce();
  });

  it('should report the INBOX message count and the folder count', async () => {
    expect(await testImap(account)).toEqual({
      success: true,
      details: { messages: 12, folders: 2 },
    });
  });

  it('should log out after a successful probe', async () => {
    await testImap(account);
    expect(h.logout).toHaveBeenCalledOnce();
  });

  it('should count the first folder when the account has no INBOX', async () => {
    h.missing.add('INBOX');
    expect(await testImap(account)).toEqual({
      success: true,
      details: { messages: 1834, folders: 2 },
    });
  });

  it('should report no message count when STATUS on the first folder resolves false', async () => {
    h.missing.add('INBOX');
    h.refused.add('[Gmail]/All Mail');
    expect(await testImap(account)).toEqual({
      success: true,
      details: { messages: 0, folders: 2 },
    });
  });

  it('should report success with no message count when no folder answers STATUS', async () => {
    h.missing.add('INBOX');
    h.missing.add('[Gmail]/All Mail');
    expect(await testImap(account)).toEqual({
      success: true,
      details: { messages: 0, folders: 2 },
    });
  });

  // A false answer means INBOX exists, so the first-folder fallback for a missing INBOX stays out.
  it('should report no message count when STATUS on INBOX resolves false', async () => {
    h.refused.add('INBOX');
    expect(await testImap(account)).toEqual({
      success: true,
      details: { messages: 0, folders: 2 },
    });
  });

  it.each([
    ['the password', () => account, 'wrong-password'],
    ['the OAuth2 access token', oauthAccount, ACCESS_TOKEN],
  ])(
    'should leave %s that imapflow keeps in response and responseText out of the result',
    async (_quoted, probed, secret) => {
      h.connectError = imapflowRefusal(secret);
      const result = await testImap(probed(), tokens);
      expect({ success: result.success, quoted: JSON.stringify(result).includes(secret) }).toEqual({
        success: false,
        quoted: false,
      });
    },
  );

  // imapflow 2 never puts the server's text in `message` (see imapflowRefusal); these stand for
  // another source, or a later version, that does.
  describe('defensive input: a refusal whose message quotes the server', () => {
    it('should redact the password a refused login quotes', async () => {
      h.connectError = new Error(
        'Command failed: NO [AUTHENTICATIONFAILED] wrong-password rejected',
      );
      expect(await testImap(account)).toEqual({
        success: false,
        error: 'Command failed: NO [AUTHENTICATIONFAILED] [redacted] rejected',
      });
    });

    it('should redact the OAuth2 access token a refused login quotes', async () => {
      h.connectError = new Error(
        `Command failed: NO [AUTHENTICATIONFAILED] ${ACCESS_TOKEN} expired`,
      );
      expect(await testImap(oauthAccount(), tokens)).toEqual({
        success: false,
        error: 'Command failed: NO [AUTHENTICATIONFAILED] [redacted] expired',
      });
    });
  });

  it('should cut a long error to the cap', async () => {
    h.connectError = new Error('x'.repeat(MAX_ERROR_TEXT_LENGTH * 2));
    expect(await testImap(account)).toEqual({
      success: false,
      error: `${'x'.repeat(MAX_ERROR_TEXT_LENGTH - 1)}…`,
    });
  });

  it('should report a connection that fails after login without raising an uncaught error', async () => {
    h.socketError = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const result = await testImap(account);
    expect({ result, uncaught: h.uncaught }).toEqual({
      result: { success: false, error: 'Connection not available' },
      uncaught: [],
    });
  });
});

describe('testSmtp', () => {
  it('should close the transport after a successful verify', async () => {
    expect(await testSmtp(account)).toEqual({ success: true });
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('should report the refused login and close the transport', async () => {
    h.verifyError = Object.assign(
      new Error('Invalid login: 535-5.7.8 Username and Password not accepted'),
      { code: 'EAUTH', responseCode: 535 },
    );
    expect(await testSmtp(account)).toEqual({
      success: false,
      error: 'Invalid login: 535-5.7.8 Username and Password not accepted',
    });
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('should redact the AUTH PLAIN blob a 535 reply quotes', async () => {
    h.verifyError = Object.assign(
      new Error(
        'Invalid login: 535 5.7.8 Error: authentication failed: AHdvcmtAZXhhbXBsZS5jb20Ad3JvbmctcGFzc3dvcmQ=',
      ),
      { code: 'EAUTH', responseCode: 535 },
    );
    expect(await testSmtp(account)).toEqual({
      success: false,
      error: 'Invalid login: 535 5.7.8 Error: authentication failed: [redacted]',
    });
  });

  it('should redact the AUTH PLAIN blob built from a login name that differs from the address', async () => {
    h.verifyError = Object.assign(
      new Error(
        'Invalid login: 535 5.7.8 Error: authentication failed: AHdvcmstbG9naW4Ad3JvbmctcGFzc3dvcmQ=',
      ),
      { code: 'EAUTH', responseCode: 535 },
    );
    expect(await testSmtp({ ...account, username: 'work-login' })).toEqual({
      success: false,
      error: 'Invalid login: 535 5.7.8 Error: authentication failed: [redacted]',
    });
  });

  it('should redact the OAuth2 access token a 535 reply quotes', async () => {
    h.verifyError = Object.assign(
      new Error(`Invalid login: 535 5.7.8 Token ${ACCESS_TOKEN} is not valid`),
      { code: 'EAUTH', responseCode: 535 },
    );
    expect(await testSmtp(oauthAccount(), tokens)).toEqual({
      success: false,
      error: 'Invalid login: 535 5.7.8 Token [redacted] is not valid',
    });
  });

  it('should redact a rejection that is not an Error', async () => {
    h.verifyError = '535 5.7.8 wrong-password rejected';
    expect(await testSmtp(account)).toEqual({
      success: false,
      error: '535 5.7.8 [redacted] rejected',
    });
  });

  it('should cut a long error to the cap', async () => {
    h.verifyError = new Error('x'.repeat(MAX_ERROR_TEXT_LENGTH * 2));
    expect(await testSmtp(account)).toEqual({
      success: false,
      error: `${'x'.repeat(MAX_ERROR_TEXT_LENGTH - 1)}…`,
    });
  });
});
