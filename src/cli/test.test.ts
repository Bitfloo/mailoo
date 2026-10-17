import XOAuth2 from 'nodemailer/lib/xoauth2';

import runTest from './test.js';

const h = vi.hoisted(() => ({
  printed: [] as string[],
  // The token the stubbed token endpoint issues; the fake servers accept nothing else.
  issuedToken: 'ya29.issued-by-refresh',
}));

vi.mock('@clack/prompts', () => ({
  intro: () => {},
  outro: (message: string) => {
    h.printed.push(message);
  },
  log: {
    step: () => {},
    error: (message: string) => {
      h.printed.push(message);
    },
  },
  spinner: () => ({
    start: () => {},
    stop: (message: string) => {
      h.printed.push(message);
    },
  }),
}));

async function tokenFor(generator: XOAuth2): Promise<string> {
  return new Promise((resolve, reject) => {
    generator.getToken(false, (err, token) => (err ? reject(err) : resolve(token)));
  });
}

// Gmail-style servers: XOAUTH2 only, so a password login without a password is refused.
vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(private readonly options: { auth: { accessToken?: string } }) {}

    on(): this {
      return this;
    }

    async connect(): Promise<void> {
      if (this.options.auth.accessToken !== h.issuedToken) {
        throw new Error('Command failed: AUTHENTICATIONFAILED Invalid credentials');
      }
    }

    // eslint-disable-next-line class-methods-use-this
    async list(): Promise<{ path: string }[]> {
      return [{ path: 'INBOX' }, { path: 'Sent' }];
    }

    // eslint-disable-next-line class-methods-use-this
    async status(): Promise<{ messages: number }> {
      return { messages: 3 };
    }

    // eslint-disable-next-line class-methods-use-this
    async logout(): Promise<void> {}
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: { auth: { type?: string } }) => ({
      verify: async () => {
        if (options.auth.type !== 'OAuth2') {
          throw new Error('Invalid login: 535-5.7.8 Username and Password not accepted');
        }
        // nodemailer builds its XOAUTH2 generator from these auth options on every connection.
        const token = await tokenFor(new XOAuth2(options.auth as never));
        if (token !== h.issuedToken) throw new Error('Invalid login: 535 invalid token');
        return true;
      },
      close: () => {},
    }),
  },
}));

beforeEach(() => {
  h.printed.length = 0;
  // Single-account env config with OAuth2 and no password, as documented in the README.
  vi.stubEnv('MCP_EMAIL_ADDRESS', 'me@example.com');
  vi.stubEnv('MCP_EMAIL_PASSWORD', undefined);
  vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
  vi.stubEnv('MCP_EMAIL_SMTP_HOST', 'smtp.example.com');
  vi.stubEnv('MCP_EMAIL_OAUTH2_PROVIDER', 'google');
  vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_ID', 'client-id');
  vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('MCP_EMAIL_OAUTH2_REFRESH_TOKEN', 'refresh-token');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ access_token: h.issuedToken, expires_in: 3600 })),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('mailoo test with an OAuth2 account', () => {
  it('should log in to IMAP with the access token from the refresh', async () => {
    await runTest().catch(() => {});
    expect(h.printed).toContain('IMAP  ✓ imap.example.com:993 — 3 messages, 2 folders');
  });

  it('should log in to SMTP with the access token from the refresh', async () => {
    await runTest().catch(() => {});
    expect(h.printed).toContain('SMTP  ✓ smtp.example.com:465 — authenticated');
  });

  it('should report every connection as OK', async () => {
    await expect(runTest()).resolves.toBeUndefined();
  });
});
