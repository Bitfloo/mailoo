import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { SmtpAuth } from '../connections/auth.js';
import ConnectionManager from '../connections/manager.js';
import type { AccessTokenSource } from '../connections/types.js';
import createServer from '../server.js';
import ImapService from '../services/imap.service.js';
import type { AccountConfig } from '../types/index.js';
import registerHealthTools from './health.tool.js';

const h = vi.hoisted(() => ({
  connectError: null as Error | null,
  verifyError: null as Error | null,
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('imapflow', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    ImapFlow: class extends EventEmitter {
      usable = true;

      capabilities = new Map([['IMAP4rev1', true]]);

      // eslint-disable-next-line class-methods-use-this
      async connect(): Promise<void> {
        if (h.connectError) throw h.connectError;
      }

      // eslint-disable-next-line class-methods-use-this
      async getQuota(): Promise<false> {
        return false;
      }

      // eslint-disable-next-line class-methods-use-this
      close(): void {}
    },
  };
});

// nodemailer asks for the token while it authenticates, then the server answers.
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

const PASSWORD = 'S3cret-Pa55word!';
const ACCESS_TOKEN = 'ya29.fake-access-token-0123456789';
const XOAUTH2_BLOB = Buffer.from(
  `user=work@example.com\u0001auth=Bearer ${ACCESS_TOKEN}\u0001\u0001`,
).toString('base64');

const tokens: AccessTokenSource = { getAccessToken: async () => ACCESS_TOKEN };

function passwordAccount(): AccountConfig {
  return {
    name: 'work',
    email: 'work@example.com',
    username: 'work@example.com',
    password: PASSWORD,
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
  };
}

// A fresh oauth2 object per test: the issued token is recorded against it, and a token left by
// one test would let another pass without recording its own.
function oauthAccount(): AccountConfig {
  return {
    ...passwordAccount(),
    password: undefined,
    oauth2: {
      provider: 'google',
      clientId: 'fake-client-id',
      clientSecret: 'fake-client-secret',
      refreshToken: 'fake-refresh-token',
    },
  };
}

const QUOTED_SECRETS = [
  ['the password', passwordAccount, PASSWORD],
  ['the OAuth2 access token', oauthAccount, ACCESS_TOKEN],
  ['the XOAUTH2 blob', oauthAccount, XOAUTH2_BLOB],
] as const;

// imapflow 2 keeps the server's text in `response` and `responseText`, never in `message`; this
// message stands for any other source that does quote it.
function imapRefusal(secret: string): Error {
  return new Error(`Command failed: NO [AUTHENTICATIONFAILED] ${secret} rejected`);
}

/** nodemailer's EAUTH shape: the server line in the message and in `response`. */
function smtpRefusal(secret: string): Error {
  return Object.assign(new Error(`Invalid login: 535 5.7.8 ${secret} rejected`), {
    code: 'EAUTH',
    response: `535 5.7.8 ${secret} rejected`,
    responseCode: 535,
    command: 'AUTH PLAIN',
  });
}

interface AccountHealth {
  imap: { error?: string };
  smtp: { error?: string };
}

function firstAccountHealth(content: unknown): AccountHealth {
  if (!Array.isArray(content)) throw new Error('check_health returned no content');
  const [block] = content as { text?: unknown }[];
  if (typeof block?.text !== 'string') throw new Error('check_health returned no text');
  const { accounts } = JSON.parse(block.text) as { accounts: AccountHealth[] };
  if (!accounts[0]) throw new Error('check_health reported no account');
  return accounts[0];
}

async function checkHealth(manager: ConnectionManager): Promise<AccountHealth> {
  const server = createServer();
  registerHealthTools(server, manager, new ImapService(manager));
  const client = new Client({ name: 'mailoo-health', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: 'check_health', arguments: { account: 'work' } });
    return firstAccountHealth(result.content);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

beforeEach(() => {
  h.connectError = null;
  h.verifyError = null;
  // The backoff text names the seconds left, so the clock and the jitter stay put.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('check_health on a refused IMAP login', () => {
  it.each(QUOTED_SECRETS)(
    'should report the IMAP error with %s redacted',
    async (_quoted, account, secret) => {
      h.connectError = imapRefusal(secret);
      const health = await checkHealth(new ConnectionManager([account()], tokens));
      expect(health.imap.error).toBe(
        'Command failed: NO [AUTHENTICATIONFAILED] [redacted] rejected',
      );
    },
  );

  it.each(QUOTED_SECRETS)(
    'should repeat the IMAP error with %s redacted while the next connect waits',
    async (_quoted, account, secret) => {
      h.connectError = imapRefusal(secret);
      const manager = new ConnectionManager([account()], tokens);
      await checkHealth(manager);
      const health = await checkHealth(manager);
      expect(health.imap.error).toBe(
        'Last IMAP connect for "work" failed: Command failed: NO [AUTHENTICATIONFAILED] [redacted] rejected (next attempt in 1s)',
      );
    },
  );
});

describe('check_health on a refused SMTP login', () => {
  it.each(QUOTED_SECRETS)(
    'should report the SMTP error with %s redacted',
    async (_quoted, account, secret) => {
      h.verifyError = smtpRefusal(secret);
      const health = await checkHealth(new ConnectionManager([account()], tokens));
      expect(health.smtp.error).toBe('Invalid login: 535 5.7.8 [redacted] rejected');
    },
  );

  // The IMAP login used a token that expired before nodemailer asked for one.
  it('should redact the newer token nodemailer asked for after the IMAP login', async () => {
    const issued = ['ya29.fake-imap-token-0123456789', 'ya29.fake-smtp-token-0123456789'];
    const refreshing: AccessTokenSource = { getAccessToken: async () => issued.shift() ?? '' };
    h.verifyError = smtpRefusal('ya29.fake-smtp-token-0123456789');
    const health = await checkHealth(new ConnectionManager([oauthAccount()], refreshing));
    expect(health.smtp.error).toBe('Invalid login: 535 5.7.8 [redacted] rejected');
  });

  it.each(QUOTED_SECRETS)(
    'should repeat the SMTP error with %s redacted while the next connect waits',
    async (_quoted, account, secret) => {
      h.verifyError = smtpRefusal(secret);
      const manager = new ConnectionManager([account()], tokens);
      await checkHealth(manager);
      const health = await checkHealth(manager);
      expect(health.smtp.error).toBe(
        'Last SMTP connect for "work" failed: Invalid login: 535 5.7.8 [redacted] rejected (next attempt in 1s)',
      );
    },
  );
});
