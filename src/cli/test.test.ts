import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import XOAuth2 from 'nodemailer/lib/xoauth2';

import runTest from './test.js';

const h = vi.hoisted(() => ({
  printed: [] as string[],
  // The token the stubbed token endpoint issues; the fake servers accept nothing else.
  issuedToken: 'ya29.issued-by-refresh',
  // Set to make one server refuse the connection whatever the credentials.
  imapRefusals: new Map<string, Error>(),
  smtpRefusal: null as Error | null,
}));

// The config file path is fixed when the config module loads, so the directory is pinned
// before the imports run; no test may read the developer's own config.
const configHome = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'mailoo-cli-test-'));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  return dir;
});

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
    constructor(private readonly options: { host: string; auth: { accessToken?: string } }) {}

    on(): this {
      return this;
    }

    async connect(): Promise<void> {
      const refusal = h.imapRefusals.get(this.options.host);
      if (refusal) throw refusal;
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
        if (h.smtpRefusal) throw h.smtpRefusal;
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
  h.imapRefusals.clear();
  h.smtpRefusal = null;
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

afterAll(async () => {
  await rm(configHome, { recursive: true, force: true });
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

describe('mailoo test with a failing login', () => {
  beforeEach(() => {
    // The token endpoint answers, but with a token the servers no longer accept.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ access_token: 'ya29.revoked', expires_in: 3600 })),
    );
  });

  it('should fail the command when a login fails', async () => {
    await expect(runTest()).rejects.toThrow('Connection tests failed');
  });

  it('should print the IMAP login failure', async () => {
    await runTest().catch(() => {});
    expect(h.printed).toContain(
      'IMAP  ✗ imap.example.com:993 — Command failed: AUTHENTICATIONFAILED Invalid credentials',
    );
  });
});

// Node's message for a refused TCP connect; 192.0.2.0/24 is reserved for documentation.
describe('mailoo test with one protocol refused', () => {
  it('should fail the command when only IMAP is refused', async () => {
    h.imapRefusals.set(
      'imap.example.com',
      Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:993'), { code: 'ECONNREFUSED' }),
    );
    await expect(runTest()).rejects.toThrow('Connection tests failed');
    expect(h.printed).toContain(
      'IMAP  ✗ imap.example.com:993 — connect ECONNREFUSED 192.0.2.10:993',
    );
  });

  it('should fail the command when only SMTP is refused', async () => {
    h.smtpRefusal = Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:465'), {
      code: 'ECONNREFUSED',
    });
    await expect(runTest()).rejects.toThrow('Connection tests failed');
    expect(h.printed).toContain(
      'SMTP  ✗ smtp.example.com:465 — connect ECONNREFUSED 192.0.2.10:465',
    );
  });
});

function oauthAccount(name: string): string {
  return `[[accounts]]
name = "${name}"
email = "${name}@example.com"

[accounts.oauth2]
provider = "google"
client_id = "client-id"
client_secret = "client-secret"
refresh_token = "refresh-token"

[accounts.imap]
host = "imap.${name}.example.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.${name}.example.com"
port = 465
tls = true
`;
}

describe('mailoo test with two accounts in the config file', () => {
  beforeEach(async () => {
    vi.stubEnv('MCP_EMAIL_ADDRESS', undefined);
    await mkdir(join(configHome, 'mailoo'), { recursive: true });
    await writeFile(
      join(configHome, 'mailoo', 'config.toml'),
      `${oauthAccount('first')}\n${oauthAccount('second')}`,
      { mode: 0o600 },
    );
  });

  it('should fail the command when the first of two accounts is refused and the second is fine', async () => {
    h.imapRefusals.set(
      'imap.first.example.com',
      Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:993'), { code: 'ECONNREFUSED' }),
    );
    await expect(runTest()).rejects.toThrow('Connection tests failed');
  });

  it('should fail the command when the second of two accounts is refused and the first is fine', async () => {
    h.imapRefusals.set(
      'imap.second.example.com',
      Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:993'), { code: 'ECONNREFUSED' }),
    );
    await expect(runTest()).rejects.toThrow('Connection tests failed');
  });
});

describe('mailoo test with an account filter', () => {
  it('should fail the command when no account has that name', async () => {
    await expect(runTest('nope')).rejects.toThrow('No matching accounts found');
  });
});
