import XOAuth2 from 'nodemailer/lib/xoauth2';

import OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

const { smtpTransports, verifyErrors } = vi.hoisted(() => ({
  // Errors the next verify() calls reject with, in order; empty means success.
  verifyErrors: [] as Error[],
  smtpTransports: [] as {
    options: Record<string, unknown>;
    verify: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      const transport = {
        options,
        verify: vi.fn(
          async () =>
            new Promise<true>((resolve, reject) => {
              const error = verifyErrors.shift();
              setImmediate(() => (error ? reject(error) : resolve(true)));
            }),
        ),
        close: vi.fn(),
      };
      smtpTransports.push(transport);
      return transport;
    },
  },
}));

const account: AccountConfig = {
  name: 'test',
  email: 'user@example.com',
  username: 'user@example.com',
  password: 'x',
  imap: {
    host: 'imap.strato.de',
    port: 993,
    tls: true,
    starttls: false,
    verifySsl: true,
    disableImap4rev2: true,
  },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('ConnectionManager SMTP transport options', () => {
  beforeEach(() => {
    smtpTransports.length = 0;
  });

  async function optionsFor(
    smtp: Partial<AccountConfig['smtp']>,
  ): Promise<Record<string, unknown>> {
    const manager = new ConnectionManager([{ ...account, smtp: { ...account.smtp, ...smtp } }]);
    await manager.getSmtpTransport('test');
    return smtpTransports[0].options;
  }

  it('should verify the server certificate when verifySsl is true', async () => {
    const options = await optionsFor({ verifySsl: true });
    expect(options.tls).toEqual({ rejectUnauthorized: true });
  });

  it('should skip certificate verification only when verifySsl is false', async () => {
    const options = await optionsFor({ verifySsl: false });
    expect(options.tls).toEqual({ rejectUnauthorized: false });
  });

  it('should pool one connection for 100 messages when no pool block is configured', async () => {
    const options = await optionsFor({});
    expect(options).toMatchObject({ pool: true, maxConnections: 1, maxMessages: 100 });
  });

  it('should not pool when pool.enabled is false', async () => {
    const options = await optionsFor({
      pool: { enabled: false, maxConnections: 5, maxMessages: 10 },
    });
    expect(options.pool).toBe(false);
    expect(options).not.toHaveProperty('maxConnections');
  });

  it.each([
    [true, false, { secure: true, requireTLS: false, ignoreTLS: false }],
    [false, true, { secure: false, requireTLS: true, ignoreTLS: false }],
    [false, false, { secure: false, requireTLS: false, ignoreTLS: true }],
  ] as const)('should map tls=%s starttls=%s to %o', async (tls, starttls, expected) => {
    const options = await optionsFor({ tls, starttls });
    expect(options).toMatchObject(expected);
  });
});

describe('ConnectionManager.getSmtpTransport', () => {
  beforeEach(() => {
    smtpTransports.length = 0;
  });

  it('should build exactly one transport when 20 callers ask for the same account at once', async () => {
    const manager = new ConnectionManager([account]);
    const transports = await Promise.all(
      Array.from({ length: 20 }, async () => manager.getSmtpTransport('test')),
    );
    expect(smtpTransports).toHaveLength(1);
    expect(new Set(transports).size).toBe(1);
  });
});

describe('ConnectionManager.closeAll for SMTP', () => {
  beforeEach(() => {
    smtpTransports.length = 0;
  });

  it('should close every cached SMTP transport', async () => {
    const manager = new ConnectionManager([account, { ...account, name: 'second' }]);
    await manager.getSmtpTransport('test');
    await manager.getSmtpTransport('second');
    await manager.closeAll();
    expect(smtpTransports.map((transport) => transport.close.mock.calls.length)).toEqual([1, 1]);
  });
});

describe('ConnectionManager SMTP reconnect backoff', () => {
  beforeEach(() => {
    smtpTransports.length = 0;
    verifyErrors.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should close an SMTP transport whose verify failed and back off the next attempt', async () => {
    verifyErrors.push(new Error('535 Authentication failed'));
    const manager = new ConnectionManager([account]);
    await expect(manager.getSmtpTransport('test')).rejects.toThrow('535');
    expect(smtpTransports[0].close).toHaveBeenCalledOnce();
    await expect(manager.getSmtpTransport('test')).rejects.toThrow(
      'Last SMTP connect for "test" failed: 535 Authentication failed',
    );
    expect(smtpTransports).toHaveLength(1);
  });
});

describe('ConnectionManager SMTP OAuth2', () => {
  const oauthAccount: AccountConfig = {
    ...account,
    name: 'work',
    password: undefined,
    oauth2: {
      provider: 'google',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    },
  };

  beforeEach(() => {
    smtpTransports.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    let issued = 0;
    // Google's token endpoint answers each refresh with a new token valid for one hour.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        issued += 1;
        return new Response(JSON.stringify({ access_token: `tok-${issued}`, expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function tokenFor(oauth2: XOAuth2): Promise<string> {
    return new Promise((resolve, reject) => {
      oauth2.getToken(false, (err, token) => (err ? reject(err) : resolve(token)));
    });
  }

  it('should hand the cached transport a fresh token after the first one expired', async () => {
    const manager = new ConnectionManager([structuredClone(oauthAccount)], new OAuthService());
    await manager.getSmtpTransport('work');
    // nodemailer builds one XOAuth2 generator per connection from these auth options.
    const generator = new XOAuth2(smtpTransports[0].options.auth as never);
    expect(await tokenFor(generator)).toBe('tok-1');
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(await tokenFor(generator)).toBe('tok-2');
  });
});
