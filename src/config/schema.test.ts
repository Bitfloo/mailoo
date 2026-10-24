import { readFile } from 'node:fs/promises';

import {
  AccountConfigSchema,
  AppConfigFileSchema,
  ImapConfigSchema,
  OAuth2ConfigSchema,
  SettingsSchema,
  SmtpConfigSchema,
  SystemOneConfigSchema,
} from './schema.js';

const validImap = { host: 'imap.example.com' };
const validSmtp = { host: 'smtp.example.com' };

function validAccount(overrides = {}) {
  return {
    name: 'test',
    email: 'user@example.com',
    password: 'secret',
    imap: validImap,
    smtp: validSmtp,
    ...overrides,
  };
}

describe('ImapConfigSchema', () => {
  it('applies default port of 993', () => {
    const result = ImapConfigSchema.parse({ host: 'imap.example.com' });
    expect(result.port).toBe(993);
  });

  it('rejects port 0', () => {
    expect(() => ImapConfigSchema.parse({ host: 'imap.example.com', port: 0 })).toThrow();
  });

  it('rejects port 65536', () => {
    expect(() => ImapConfigSchema.parse({ host: 'imap.example.com', port: 65536 })).toThrow();
  });

  it('accepts port 143 for STARTTLS IMAP', () => {
    const result = ImapConfigSchema.parse({ host: 'imap.example.com', port: 143 });
    expect(result.port).toBe(143);
  });

  it('accepts disable_imap4rev2', () => {
    const result = ImapConfigSchema.parse({ host: 'imap.strato.de', disable_imap4rev2: true });
    expect(result.disable_imap4rev2).toBe(true);
  });
});

describe('SmtpConfigSchema', () => {
  it('applies default port of 465', () => {
    const result = SmtpConfigSchema.parse({ host: 'smtp.example.com' });
    expect(result.port).toBe(465);
  });

  it('rejects port 0', () => {
    expect(() => SmtpConfigSchema.parse({ host: 'smtp.example.com', port: 0 })).toThrow();
  });

  it('rejects port 65536', () => {
    expect(() => SmtpConfigSchema.parse({ host: 'smtp.example.com', port: 65536 })).toThrow();
  });

  it('applies pool defaults', () => {
    const result = SmtpConfigSchema.parse({ host: 'smtp.example.com' });
    expect(result.pool).toEqual({
      enabled: true,
      max_connections: 1,
      max_messages: 100,
    });
  });
});

describe('AccountConfigSchema', () => {
  it('accepts valid minimal config with password', () => {
    const result = AccountConfigSchema.parse(validAccount());
    expect(result.name).toBe('test');
    expect(result.email).toBe('user@example.com');
  });

  it('accepts valid config with oauth2 instead of password', () => {
    const result = AccountConfigSchema.parse(
      validAccount({
        password: undefined,
        oauth2: {
          provider: 'google',
          client_id: 'id',
          client_secret: 'secret',
          refresh_token: 'token',
        },
      }),
    );
    expect(result.oauth2?.provider).toBe('google');
  });

  it('rejects when neither password nor oauth2 provided', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ password: undefined }))).toThrow(
      'password or oauth2',
    );
  });

  it('rejects missing name', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ name: '' }))).toThrow();
  });

  it('rejects invalid email format', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ email: 'not-an-email' }))).toThrow();
  });

  it('rejects missing imap', () => {
    expect(() => AccountConfigSchema.parse({ ...validAccount(), imap: undefined })).toThrow();
  });

  it('rejects missing smtp', () => {
    expect(() => AccountConfigSchema.parse({ ...validAccount(), smtp: undefined })).toThrow();
  });
});

// tls = false with starttls = false sends the password or OAuth token in clear text.
describe.each([
  ['imap', 'IMAP'],
  ['smtp', 'SMTP'],
] as const)('AccountConfigSchema %s with tls = false and starttls = false', (protocol, label) => {
  function accountOn(host: string, security = { tls: false, starttls: false }) {
    return validAccount({ name: 'work', [protocol]: { host, ...security } });
  }

  function issuesOf(input: unknown): string[] {
    return (AccountConfigSchema.safeParse(input).error?.issues ?? []).map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
  }

  function issuePaths(input: unknown): string[] {
    return (AccountConfigSchema.safeParse(input).error?.issues ?? []).map((issue) =>
      issue.path.join('.'),
    );
  }

  it.each([
    ['localhost', 'localhost'],
    ['upper-case localhost', 'LOCALHOST'],
    ['mixed-case localhost', 'LocalHost'],
    ['127.0.0.1', '127.0.0.1'],
    ['another 127/8 address', '127.0.0.2'],
    ['the top of 127/8', '127.255.255.254'],
    ['::1', '::1'],
    ['bracketed ::1', '[::1]'],
  ])(`should accept ${label} on %s (%j)`, (_kind, host) => {
    expect(issuesOf(accountOn(host))).toEqual([]);
  });

  // Only localhost and IP literals count: a client looks up any other spelling,
  // '127.1' included, as a name.
  it.each([
    ['short IPv4', '127.1'],
    ['IPv4-mapped IPv6', '::ffff:127.0.0.1'],
    ['localhost with a trailing dot', 'localhost.'],
    ['127.0.0.1 with a trailing dot', '127.0.0.1.'],
    ['padded localhost', ' localhost '],
    ['the unspecified address', '0.0.0.0'],
    ['the address after 127/8', '128.0.0.1'],
    ['the address before 127/8', '126.255.255.255'],
    ['a name under localhost', 'localhost.example.com'],
    ['a name starting with 127.0.0.1', '127.0.0.1.example.com'],
    ['a remote name', 'mail.example.com'],
    ['a ::1 that closes its bracket early', '::1]:80/['],
  ])(`should refuse ${label} on %s (%j) at ${protocol}.tls`, (_kind, host) => {
    expect(issuePaths(accountOn(host))).toEqual([`${protocol}.tls`]);
  });

  it(`should name the account, ${label}, the host, both settings and the loopback hosts in the refusal`, () => {
    expect(issuesOf(accountOn('mail.example.com'))).toEqual([
      `${protocol}.tls: Account "work": ${label} to "mail.example.com" would be unencrypted ` +
        '(tls = false and starttls = false). Set tls = true or starttls = true, ' +
        'or use a loopback host (localhost, 127.0.0.0/8 or ::1).',
    ]);
  });

  it(`should accept ${label} with tls = true alone on a remote host`, () => {
    expect(issuesOf(accountOn('mail.example.com', { tls: true, starttls: false }))).toEqual([]);
  });

  it(`should accept ${label} with starttls = true alone on a remote host`, () => {
    expect(issuesOf(accountOn('mail.example.com', { tls: false, starttls: true }))).toEqual([]);
  });

  // The blank-host issue already says what to fix; a second one about the same host is noise.
  it(`should report only the missing host when the ${label} host is blank`, () => {
    expect(issuesOf(accountOn('   '))).toEqual([`${protocol}.host: ${label} host is required`]);
  });
});

describe('AccountConfigSchema with IMAP and SMTP both unencrypted', () => {
  it('should refuse each protocol separately when both go to a remote host', () => {
    const plain = { tls: false, starttls: false };
    const account = validAccount({
      imap: { host: 'imap.example.com', ...plain },
      smtp: { host: 'smtp.example.com', ...plain },
    });

    expect(AccountConfigSchema.safeParse(account).error?.issues.map((i) => i.path)).toEqual([
      ['imap', 'tls'],
      ['smtp', 'tls'],
    ]);
  });
});

// The token endpoint receives client_secret and refresh_token in the POST body.
describe('OAuth2ConfigSchema custom endpoints', () => {
  function customOAuth(endpoint: string) {
    return {
      provider: 'custom' as const,
      client_id: 'id',
      client_secret: 'secret',
      refresh_token: 'token',
      token_url: endpoint,
      auth_url: endpoint,
    };
  }

  it.each([
    'https://auth.example.com/token',
    'http://127.0.0.1:8080/token',
    'http://127.0.0.2:8080/token',
    'http://[::1]:8080/token',
    'http://localhost:8080/token',
    // Unlike an IMAP or SMTP host, a URL's host is canonicalised: fetch connects to 127.0.0.1.
    'http://127.1/token',
  ])('should accept %s', (endpoint) => {
    expect(OAuth2ConfigSchema.safeParse(customOAuth(endpoint)).success).toBe(true);
  });

  it.each([
    'http://auth.example.com/token',
    'http://10.0.0.5/token',
    'http://localhost.example.com/token',
    'ftp://auth.example.com/token',
    'not a url',
  ])('should reject %s', (endpoint) => {
    expect(OAuth2ConfigSchema.safeParse(customOAuth(endpoint)).success).toBe(false);
  });

  // Only plain http earns the loopback exception; another scheme is not https either.
  it.each(['ftp://localhost/token', 'ws://127.0.0.1/token'])(
    'should reject %s although its host is loopback',
    (endpoint) => {
      const config = { ...customOAuth('https://auth.example.com/token'), token_url: endpoint };
      expect(OAuth2ConfigSchema.safeParse(config).success).toBe(false);
    },
  );

  // Zod runs the https refine after .url() failed; a second issue would blame
  // the scheme when the value is not a URL at all.
  it('should report one issue for a token_url that is not a URL', () => {
    const config = { ...customOAuth('https://auth.example.com/token'), token_url: 'not a url' };
    expect(OAuth2ConfigSchema.safeParse(config).error?.issues).toHaveLength(1);
  });

  it('should reject an http token_url even when auth_url is https', () => {
    const config = {
      ...customOAuth('https://auth.example.com/authorize'),
      token_url: 'http://auth.example.com/token',
    };
    expect(OAuth2ConfigSchema.safeParse(config).error?.issues[0]?.path).toEqual(['token_url']);
  });

  it('should reject an http auth_url even when token_url is https', () => {
    const config = {
      ...customOAuth('https://auth.example.com/token'),
      auth_url: 'http://auth.example.com/authorize',
    };
    expect(OAuth2ConfigSchema.safeParse(config).error?.issues[0]?.path).toEqual(['auth_url']);
  });

  // The README and the rejection message list in prose what isLoopbackHost accepts.
  it.each([
    [
      'README.md',
      async () => {
        const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
        const sentence = /plain `http` is accepted only for ([^(]+)\(/.exec(readme)?.[1] ?? '';
        return [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      },
    ],
    [
      'the rejection message',
      async () => {
        const { error } = OAuth2ConfigSchema.safeParse(
          customOAuth('http://auth.example.com/token'),
        );
        const hosts = /http only for (.+)\)$/.exec(error?.issues[0]?.message ?? '')?.[1] ?? '';
        return hosts.split(/, | or /);
      },
    ],
  ])('should name exactly the loopback hosts in %s', async (_source, listedHosts) => {
    expect((await listedHosts()).sort()).toEqual(['127.0.0.0/8', '::1', 'localhost']);
  });

  it('should name https in the rejection message', () => {
    expect(() => OAuth2ConfigSchema.parse(customOAuth('http://auth.example.com/token'))).toThrow(
      /https/,
    );
  });
});

describe('SettingsSchema', () => {
  it('applies default rate_limit of 10', () => {
    const result = SettingsSchema.parse({});
    expect(result.rate_limit).toBe(10);
  });

  it('applies default save_to_sent of true', () => {
    const result = SettingsSchema.parse({});
    expect(result.save_to_sent).toBe(true);
  });

  it('defaults read_only to false', () => {
    expect(SettingsSchema.parse({}).read_only).toBe(false);
  });

  it('defaults toolset to full and accepts core or minimal', () => {
    expect(SettingsSchema.parse({}).toolset).toBe('full');
    expect(SettingsSchema.parse({ toolset: 'core' }).toolset).toBe('core');
    expect(SettingsSchema.parse({ toolset: 'minimal' }).toolset).toBe('minimal');
    expect(() => SettingsSchema.parse({ toolset: 'invalid' })).toThrow();
  });

  it('accepts optional default_account', () => {
    expect(SettingsSchema.parse({}).default_account).toBeUndefined();
    expect(SettingsSchema.parse({ default_account: 'work' }).default_account).toBe('work');
    expect(() => SettingsSchema.parse({ default_account: '' })).toThrow();
  });

  it('defaults system_one enabled/auto_move/auto_flag/include_body to false and is_critical_min to 0.85', () => {
    const result = SettingsSchema.parse({});
    expect(result.system_one.enabled).toBe(false);
    expect(result.system_one.auto_move).toBe(false);
    expect(result.system_one.auto_flag).toBe(false);
    expect(result.system_one.include_body).toBe(false);
    expect(result.system_one.thresholds.is_critical_min).toBe(0.85);
  });

  it('should default injection_high to 0.75 not 0.70', () => {
    expect(SettingsSchema.parse({}).system_one.thresholds.injection_high).toBe(0.75);
  });

  it('should default injection_high to 0.75 when thresholds is an empty object', () => {
    expect(
      SettingsSchema.parse({ system_one: { thresholds: {} } }).system_one.thresholds.injection_high,
    ).toBe(0.75);
  });

  it('should default injection_high to 0.75 on SystemOneConfigSchema.parse({})', () => {
    expect(SystemOneConfigSchema.parse({}).thresholds.injection_high).toBe(0.75);
  });

  it('accepts custom values', () => {
    const result = SettingsSchema.parse({ rate_limit: 5, read_only: true });
    expect(result.rate_limit).toBe(5);
    expect(result.read_only).toBe(true);
  });
});

describe('AppConfigFileSchema', () => {
  it('accepts valid config with one account', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.accounts).toHaveLength(1);
  });

  it('requires at least one account', () => {
    expect(() => AppConfigFileSchema.parse({ accounts: [] })).toThrow('At least one account');
  });

  it('applies settings defaults when not provided', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.settings.rate_limit).toBe(10);
    expect(result.settings.read_only).toBe(false);
  });

  it('rejects accounts with invalid email', () => {
    expect(() =>
      AppConfigFileSchema.parse({ accounts: [validAccount({ email: 'bad' })] }),
    ).toThrow();
  });
});
