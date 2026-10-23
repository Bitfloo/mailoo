/**
 * The credential an account needs, as the account schema and the MCP_EMAIL_*
 * loader enforce it: a non-empty password or an OAuth2 block.
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { ZodError } from 'zod';

import { loadConfig } from '../src/config/loader.js';
import { AccountConfigSchema, OAuth2ConfigSchema } from '../src/config/schema.js';
import OAuthService from '../src/services/oauth.service.js';

// Every MCP_EMAIL_* variable starts unset, so only what a test sets is read.
const clearMailEnv = (): void => {
  Object.keys(process.env)
    .filter((name) => name.startsWith('MCP_EMAIL_'))
    .forEach((name) => {
      vi.stubEnv(name, undefined);
    });
};
const account = {
  name: 'work',
  email: 'owner@example.com',
  imap: { host: 'imap.example.com' },
  smtp: { host: 'smtp.example.com' },
};
// Mixed case, so a loader or schema that folds case cannot keep these values.
const oauth2 = {
  provider: 'google',
  client_id: 'Client-ID-7',
  client_secret: 'Secret-Ab9',
  refresh_token: 'Refresh-Xy3',
};
const PROVIDERS = OAuth2ConfigSchema.shape.provider.options;

describe('account schema credential', () => {
  it('should accept exactly the google, microsoft and custom providers', () => {
    expect(OAuth2ConfigSchema.shape.provider.options).toEqual(['google', 'microsoft', 'custom']);
  });

  it('should reject an account with neither a password nor OAuth2, naming the missing credential', () => {
    const issues = AccountConfigSchema.safeParse(account).error?.issues ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      'Either password or oauth2 config is required',
    ]);
  });

  it('should reject an empty password without OAuth2, naming the missing credential', () => {
    const issues = AccountConfigSchema.safeParse({ ...account, password: '' }).error?.issues ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      'Either password or oauth2 config is required',
    ]);
  });

  // The env loader hands the schema an explicit `oauth2: undefined`, so the key alone must not count.
  it('should reject an account whose oauth2 key is present but undefined, naming the missing credential', () => {
    for (const input of [
      { ...account, oauth2: undefined },
      { ...account, password: '', oauth2: undefined },
    ]) {
      const issues = AccountConfigSchema.safeParse(input).error?.issues ?? [];
      expect(issues.map((issue) => issue.message)).toEqual([
        'Either password or oauth2 config is required',
      ]);
    }
  });

  // The rest of the account block, beside the credential: each field is refused at its own path.
  it.each([
    ['an empty name', { name: '' }, 'name: Account name is required'],
    ['an email that is not an address', { email: 'owner' }, 'email: Invalid email address'],
    [
      'an empty sent mailbox',
      { sent_mailbox: '' },
      'sent_mailbox: Too small: expected string to have >=1 characters',
    ],
  ])('should refuse %s beside a password, at that field', (_label, field, issue) => {
    const issues =
      AccountConfigSchema.safeParse({ ...account, password: 'pw', ...field }).error?.issues ?? [];
    expect(issues.map((item) => `${item.path.join('.')}: ${item.message}`)).toEqual([issue]);
  });

  it.each(['token_url', 'auth_url'])('should reject an OAuth2 %s that is not a URL', (field) => {
    const partial = { ...oauth2, [field]: 'not a url' };
    const issues =
      AccountConfigSchema.safeParse({ ...account, oauth2: partial }).error?.issues ?? [];
    expect(issues.map((issue) => issue.path.join('.'))).toEqual([`oauth2.${field}`]);
  });
});

/**
 * Every credential variable, with every kind of value a launcher can pass. The
 * values are never trimmed: blank, padded and one-character values are kept as
 * given or refused exactly as they are.
 */
const NO_VALUE = [
  ['unset', undefined],
  ['empty', ''],
] as const;
const SOME_VALUE = [
  ['blank', '   '],
  ['padded', ' Xy '],
  ['short', 'X'],
] as const;
const VALUES = [...NO_VALUE, ...SOME_VALUE] as const;
// A set username is the login user as written; only an unset one falls back to the email.
const SET_USERNAME = [
  ['empty', ''],
  ['blank', '   '],
  ['padded', ' Xy '],
] as const;
// A provider must be named exactly, so these near misses are refused, not trimmed.
const NEAR_MISS_PROVIDER = [
  ['blank', '   '],
  ['padded', ' google '],
  ['short', 'Google'],
] as const;
const CLIENT_FIELDS = [
  ['client_id', 'clientId', 'MCP_EMAIL_OAUTH2_CLIENT_ID'],
  ['client_secret', 'clientSecret', 'MCP_EMAIL_OAUTH2_CLIENT_SECRET'],
  ['refresh_token', 'refreshToken', 'MCP_EMAIL_OAUTH2_REFRESH_TOKEN'],
] as const;
const eachField = <T extends readonly (readonly [string, string | undefined])[]>(values: T) =>
  CLIENT_FIELDS.flatMap(([field, key, name]) =>
    values.map(([kind, value]) => [field, kind, value, key, name] as const),
  );

type Outcome = { password: string | undefined; oauth2: unknown } | { refused: string[] };

describe('account schema credential matrix', () => {
  const parsed = (input: object): Outcome => {
    const result = AccountConfigSchema.safeParse(input);
    if (result.success) return { password: result.data.password, oauth2: result.data.oauth2 };
    return { refused: result.error.issues.map((issue) => issue.path.join('.') || '(account)') };
  };

  it.each(NO_VALUE)(
    'should refuse an account whose password is %s (%j) and has no OAuth2',
    (_kind, password) => {
      expect(parsed({ ...account, password })).toEqual({ refused: ['(account)'] });
    },
  );

  it.each(SOME_VALUE)(
    'should keep a %s password (%j) without OAuth2 as given',
    (_kind, password) => {
      expect(parsed({ ...account, password })).toEqual({ password, oauth2: undefined });
    },
  );

  it.each(PROVIDERS)(
    'should accept an empty password beside a complete %s OAuth2 block',
    (provider) => {
      const block = { ...oauth2, provider };
      expect(parsed({ ...account, password: '', oauth2: block })).toEqual({
        password: '',
        oauth2: block,
      });
    },
  );

  it.each(VALUES)(
    'should keep the password beside OAuth2 as given when it is %s (%j)',
    (_kind, password) => {
      expect(parsed({ ...account, password, oauth2 })).toEqual({ password, oauth2 });
    },
  );

  it.each([...NO_VALUE, ...NEAR_MISS_PROVIDER])(
    'should refuse the provider at oauth2.provider when it is %s (%j)',
    (_kind, provider) => {
      expect(parsed({ ...account, oauth2: { ...oauth2, provider } })).toEqual({
        refused: ['oauth2.provider'],
      });
    },
  );

  it('should leave an unset username unset in the schema', () => {
    expect(AccountConfigSchema.parse({ ...account, password: 'pw' }).username).toBeUndefined();
  });

  it.each(SET_USERNAME)('should keep a %s username (%j) as given', (_kind, username) => {
    expect(AccountConfigSchema.parse({ ...account, password: 'pw', username }).username).toBe(
      username,
    );
  });

  it('should keep padded OAuth2 scopes as given, not trimmed', () => {
    const block = { ...oauth2, scopes: [' mail ', 'offline'] };
    expect(parsed({ ...account, oauth2: block })).toEqual({ password: undefined, oauth2: block });
  });

  it('should accept an empty OAuth2 scopes list as given', () => {
    const block = { ...oauth2, scopes: [] };
    expect(parsed({ ...account, oauth2: block })).toEqual({ password: undefined, oauth2: block });
  });

  it('should accept every provider the schema names', () => {
    const { options } = OAuth2ConfigSchema.shape.provider;
    expect(
      options.map((provider) => parsed({ ...account, oauth2: { ...oauth2, provider } })),
    ).toEqual(
      options.map((provider) => ({ password: undefined, oauth2: { ...oauth2, provider } })),
    );
  });

  it.each(eachField(NO_VALUE))(
    'should refuse oauth2.%s %s (%j) at its own path',
    (field, _kind, value) => {
      const block: Record<string, string | undefined> = { ...oauth2, [field]: value };
      if (value === undefined) delete block[field];
      expect(parsed({ ...account, oauth2: block })).toEqual({ refused: [`oauth2.${field}`] });
    },
  );

  it.each(eachField(SOME_VALUE))(
    'should keep oauth2.%s %s (%j) as given',
    (field, _kind, value) => {
      const block = { ...oauth2, [field]: value };
      expect(parsed({ ...account, oauth2: block })).toEqual({ password: undefined, oauth2: block });
    },
  );
});

describe('MCP_EMAIL_* credential matrix', () => {
  const fromEnv = {
    provider: 'google',
    clientId: 'Env-Client-ID',
    clientSecret: 'Env-Secret-Q7',
    refreshToken: 'Env-Refresh-Z4',
  };
  const NO_CONFIG = { refused: ['No configuration found.'] };
  // Fresh empty directory: a file at a repo path would be read, and its values could reach an assertion diff.
  let dir: string;
  let missingConfig: string;
  // Written out, so that a weaker refusal message cannot follow the schema unnoticed.
  const providerRefusal = (): string =>
    'accounts.0.oauth2.provider: Invalid option: expected one of "google"|"microsoft"|"custom"';
  const fieldRefusal = (field: string): string =>
    `accounts.0.oauth2.${field}: OAuth2 ${field} is required`;

  const stub = (vars: Record<string, string | undefined>): void => {
    Object.entries(vars).forEach(([name, value]) => {
      vi.stubEnv(name, value);
    });
  };
  const withOAuth2 = (provider: string | undefined): Record<string, string | undefined> => ({
    MCP_EMAIL_OAUTH2_PROVIDER: provider,
    MCP_EMAIL_OAUTH2_CLIENT_ID: 'Env-Client-ID',
    MCP_EMAIL_OAUTH2_CLIENT_SECRET: 'Env-Secret-Q7',
    MCP_EMAIL_OAUTH2_REFRESH_TOKEN: 'Env-Refresh-Z4',
  });
  const loaded = async (): Promise<Outcome> => {
    try {
      const config = await loadConfig(missingConfig);
      return { password: config.accounts[0]?.password, oauth2: config.accounts[0]?.oauth2 };
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          refused: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        };
      }
      return { refused: [String((error as Error).message).split('\n')[0]] };
    }
  };

  beforeEach(async () => {
    clearMailEnv();
    vi.stubEnv('MCP_EMAIL_ADDRESS', 'owner@example.com');
    vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
    vi.stubEnv('MCP_EMAIL_SMTP_HOST', 'smtp.example.com');
    dir = await mkdtemp(join(tmpdir(), 'credential-facts-'));
    missingConfig = join(dir, 'no-such-config.toml');
    expect(dirname(relative(tmpdir(), missingConfig))).toBe(basename(dir));
    await expect(stat(missingConfig)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(NO_VALUE)(
    'should describe no account when MCP_EMAIL_PASSWORD is %s (%j) and no provider is set',
    async (_kind, password) => {
      stub({ MCP_EMAIL_PASSWORD: password });
      expect(await loaded()).toEqual(NO_CONFIG);
    },
  );

  it.each(SOME_VALUE)(
    'should load a %s MCP_EMAIL_PASSWORD (%j) as given when no provider is set',
    async (_kind, password) => {
      stub({ MCP_EMAIL_PASSWORD: password });
      expect(await loaded()).toEqual({ password, oauth2: undefined });
    },
  );

  it.each(PROVIDERS)(
    'should load an empty MCP_EMAIL_PASSWORD beside a complete %s provider',
    async (provider) => {
      stub({ ...withOAuth2(provider), MCP_EMAIL_PASSWORD: '' });
      expect(await loaded()).toEqual({ password: '', oauth2: { ...fromEnv, provider } });
    },
  );

  it.each(VALUES)(
    'should keep MCP_EMAIL_PASSWORD as given beside a provider when it is %s (%j)',
    async (_kind, password) => {
      stub({ ...withOAuth2('google'), MCP_EMAIL_PASSWORD: password });
      expect(await loaded()).toEqual({ password, oauth2: fromEnv });
    },
  );

  it.each(NO_VALUE)(
    'should describe no account when MCP_EMAIL_OAUTH2_PROVIDER is %s (%j) and no password is set',
    async (_kind, provider) => {
      stub(withOAuth2(provider));
      expect(await loaded()).toEqual(NO_CONFIG);
    },
  );

  it.each(NEAR_MISS_PROVIDER)(
    'should refuse a %s MCP_EMAIL_OAUTH2_PROVIDER (%j) at the provider, not trim it',
    async (_kind, provider) => {
      stub(withOAuth2(provider));
      expect(await loaded()).toEqual({ refused: [providerRefusal()] });
    },
  );

  it('should read every provider the schema names from MCP_EMAIL_OAUTH2_PROVIDER as given', async () => {
    const outcomes: Outcome[] = [];
    for (const provider of OAuth2ConfigSchema.shape.provider.options) {
      stub(withOAuth2(provider));
      outcomes.push(await loaded());
    }
    expect(outcomes).toEqual(
      OAuth2ConfigSchema.shape.provider.options.map((provider) => ({
        password: undefined,
        oauth2: { ...fromEnv, provider },
      })),
    );
  });

  // The variables carry no token_url or auth_url, so a custom provider loads from
  // them, but the token service cannot use it: custom needs the config file.
  it('should load a custom MCP_EMAIL_OAUTH2_PROVIDER without a token URL or an auth URL', async () => {
    stub(withOAuth2('custom'));
    const block = (await loadConfig(missingConfig)).accounts[0]?.oauth2;
    expect([block?.provider, block?.tokenUrl, block?.authUrl]).toEqual([
      'custom',
      undefined,
      undefined,
    ]);
  });

  it('should have the token service refuse a custom MCP_EMAIL_OAUTH2_PROVIDER account for its missing endpoints', async () => {
    stub(withOAuth2('custom'));
    const block = (await loadConfig(missingConfig)).accounts[0]?.oauth2;
    if (block === undefined) throw new Error('no OAuth2 block was loaded');
    expect(() => OAuthService.getProviderEndpoints(block)).toThrow(
      'Custom OAuth2 provider requires tokenUrl and authUrl',
    );
  });

  it.each(NO_VALUE)(
    'should load the password account with no OAuth2 when MCP_EMAIL_OAUTH2_PROVIDER is %s (%j)',
    async (_kind, provider) => {
      stub({ MCP_EMAIL_PASSWORD: 'app-password', MCP_EMAIL_OAUTH2_PROVIDER: provider });
      expect(await loaded()).toEqual({ password: 'app-password', oauth2: undefined });
    },
  );

  it.each(NEAR_MISS_PROVIDER)(
    'should refuse a %s MCP_EMAIL_OAUTH2_PROVIDER (%j) beside a password, with each missing OAuth2 value',
    async (_kind, provider) => {
      stub({ MCP_EMAIL_PASSWORD: 'app-password', MCP_EMAIL_OAUTH2_PROVIDER: provider });
      expect(await loaded()).toEqual({
        refused: [providerRefusal(), ...CLIENT_FIELDS.map(([field]) => fieldRefusal(field))],
      });
    },
  );

  it('should refuse a named provider beside a password when the OAuth2 values are missing', async () => {
    stub({ MCP_EMAIL_PASSWORD: 'app-password', MCP_EMAIL_OAUTH2_PROVIDER: 'google' });
    expect(await loaded()).toEqual({
      refused: CLIENT_FIELDS.map(([field]) => fieldRefusal(field)),
    });
  });

  it('should use MCP_EMAIL_USERNAME as the login user when it is set', async () => {
    stub({ MCP_EMAIL_PASSWORD: 'app-password', MCP_EMAIL_USERNAME: 'login-user' });
    const config = await loadConfig(missingConfig);
    expect(config.accounts[0]?.username).toBe('login-user');
  });

  it('should use the email address as the login user when MCP_EMAIL_USERNAME is unset', async () => {
    stub({ MCP_EMAIL_PASSWORD: 'app-password' });
    const config = await loadConfig(missingConfig);
    expect(config.accounts[0]?.username).toBe('owner@example.com');
  });

  it.each(SET_USERNAME)(
    'should keep a %s MCP_EMAIL_USERNAME (%j) as the login user, not the email address',
    async (_kind, username) => {
      stub({ MCP_EMAIL_PASSWORD: 'app-password', MCP_EMAIL_USERNAME: username });
      const config = await loadConfig(missingConfig);
      expect(config.accounts[0]?.username).toBe(username);
    },
  );

  it.each(eachField(NO_VALUE))(
    'should refuse to load when oauth2.%s is %s (%j), naming the field',
    async (field, _kind, value, _key, name) => {
      stub({ ...withOAuth2('google'), [name]: value });
      expect(await loaded()).toEqual({ refused: [fieldRefusal(field)] });
    },
  );

  it.each(eachField(SOME_VALUE))(
    'should read oauth2.%s %s (%j) from its own variable as given',
    async (_field, _kind, value, key, name) => {
      stub({ ...withOAuth2('google'), [name]: value });
      expect(await loaded()).toEqual({
        password: undefined,
        oauth2: { ...fromEnv, [key]: value },
      });
    },
  );
});

describe('MCP_EMAIL_* account beside a config file', () => {
  let dir: string;

  beforeEach(async () => {
    clearMailEnv();
    vi.stubEnv('MCP_EMAIL_ADDRESS', 'env@example.com');
    vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
    vi.stubEnv('MCP_EMAIL_SMTP_HOST', 'smtp.example.com');
    dir = await mkdtemp(join(tmpdir(), 'credential-facts-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const writeConfig = async (): Promise<string> => {
    const file = join(dir, 'config.toml');
    await writeFile(
      file,
      [
        '[[accounts]]',
        'name = "file"',
        'email = "file@example.com"',
        'password = "file-password"',
        '',
        '[accounts.imap]',
        'host = "imap.example.com"',
        '',
        '[accounts.smtp]',
        'host = "smtp.example.com"',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    return file;
  };

  // A launcher that keeps blank fields passes '', which is no credential either.
  describe.each([
    ['the password variable unset', 'MCP_EMAIL_PASSWORD', undefined],
    ['the password variable set but empty', 'MCP_EMAIL_PASSWORD', ''],
    ['no password and the provider variable set but empty', 'MCP_EMAIL_OAUTH2_PROVIDER', ''],
  ])('with %s', (_label, name, value) => {
    beforeEach(() => {
      vi.stubEnv(name, value);
    });

    it('should fall through to the config file', async () => {
      const config = await loadConfig(await writeConfig());
      expect(config.accounts.map((item) => item.email)).toEqual(['file@example.com']);
    });
  });

  // With a credential, the environment describes the account and the file is not read.
  describe.each([
    ['a password', { MCP_EMAIL_PASSWORD: 'env-password' }],
    [
      'OAuth2 and no password',
      {
        MCP_EMAIL_OAUTH2_PROVIDER: 'google',
        MCP_EMAIL_OAUTH2_CLIENT_ID: 'env-client-id',
        MCP_EMAIL_OAUTH2_CLIENT_SECRET: 'env-client-secret',
        MCP_EMAIL_OAUTH2_REFRESH_TOKEN: 'env-refresh-token',
      },
    ],
  ])('with %s in the environment', (_label, vars: Record<string, string>) => {
    beforeEach(() => {
      Object.entries(vars).forEach(([name, value]) => {
        vi.stubEnv(name, value);
      });
    });

    it('should load the environment account, not the config file', async () => {
      const config = await loadConfig(await writeConfig());
      expect(config.accounts.map((item) => item.email)).toEqual(['env@example.com']);
    });
  });
});

describe('OAuth2 account from the config file', () => {
  let dir: string;

  beforeEach(async () => {
    clearMailEnv();
    dir = await mkdtemp(join(tmpdir(), 'credential-facts-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('should map every OAuth2 field of a custom provider and hand its endpoints to the token service', async () => {
    const file = join(dir, 'config.toml');
    await writeFile(
      file,
      [
        '[[accounts]]',
        'name = "file"',
        'email = "file@example.com"',
        '',
        '[accounts.oauth2]',
        'provider = "custom"',
        'client_id = "file-id"',
        'client_secret = "file-secret"',
        'refresh_token = "file-refresh"',
        'token_url = "https://auth.example.com/token"',
        'auth_url = "https://auth.example.com/authorize"',
        'scopes = ["mail", "offline"]',
        '',
        '[accounts.imap]',
        'host = "imap.example.com"',
        '',
        '[accounts.smtp]',
        'host = "smtp.example.com"',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    const config = await loadConfig(file);
    expect(config.accounts[0]?.oauth2).toEqual({
      provider: 'custom',
      clientId: 'file-id',
      clientSecret: 'file-secret',
      refreshToken: 'file-refresh',
      tokenUrl: 'https://auth.example.com/token',
      authUrl: 'https://auth.example.com/authorize',
      scopes: ['mail', 'offline'],
    });
    const block = config.accounts[0]?.oauth2;
    if (block === undefined) throw new Error('no OAuth2 block was loaded');
    expect(OAuthService.getProviderEndpoints(block)).toEqual({
      tokenUrl: 'https://auth.example.com/token',
      authUrl: 'https://auth.example.com/authorize',
      scopes: ['mail', 'offline'],
    });
  });
});

/**
 * Empty and blank credential values in the config file, through loadConfig. TOML
 * gives the schema the values as written, with the same rule as the environment.
 */
describe('credential values in the config file', () => {
  let dir: string;

  beforeEach(async () => {
    clearMailEnv();
    dir = await mkdtemp(join(tmpdir(), 'credential-facts-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const OAUTH2_LINES = [
    '[accounts.oauth2]',
    'provider = "google"',
    'client_id = "file-id"',
    'client_secret = "file-secret"',
    'refresh_token = "file-refresh"',
    '',
  ];
  const loadedFile = async (password: string, oauth2Lines: string[]): Promise<Outcome> => {
    const file = join(dir, 'config.toml');
    await writeFile(
      file,
      [
        '[[accounts]]',
        'name = "file"',
        'email = "file@example.com"',
        `password = ${JSON.stringify(password)}`,
        '',
        ...oauth2Lines,
        '[accounts.imap]',
        'host = "imap.example.com"',
        '',
        '[accounts.smtp]',
        'host = "smtp.example.com"',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    try {
      const config = await loadConfig(file);
      return { password: config.accounts[0]?.password, oauth2: config.accounts[0]?.oauth2 };
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      return { refused: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
    }
  };
  const fileOAuth2 = {
    provider: 'google',
    clientId: 'file-id',
    clientSecret: 'file-secret',
    refreshToken: 'file-refresh',
  };

  it('should load an empty password beside an OAuth2 block, keeping both as written', async () => {
    expect(await loadedFile('', OAUTH2_LINES)).toEqual({ password: '', oauth2: fileOAuth2 });
  });

  it('should keep a blank password beside an OAuth2 block as written', async () => {
    expect(await loadedFile('   ', OAUTH2_LINES)).toEqual({ password: '   ', oauth2: fileOAuth2 });
  });

  it('should load a blank password without OAuth2 as written, not trimmed', async () => {
    expect(await loadedFile('   ', [])).toEqual({ password: '   ', oauth2: undefined });
  });

  it.each(SET_USERNAME)(
    'should keep a %s username (%j) from the file as the login user, as written',
    async (_kind, username) => {
      const file = join(dir, 'config.toml');
      await writeFile(
        file,
        [
          '[[accounts]]',
          'name = "file"',
          'email = "file@example.com"',
          `username = ${JSON.stringify(username)}`,
          'password = "file-password"',
          '',
          '[accounts.imap]',
          'host = "imap.example.com"',
          '',
          '[accounts.smtp]',
          'host = "smtp.example.com"',
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      const config = await loadConfig(file);
      expect(config.accounts[0]?.username).toBe(username);
    },
  );

  it('should load an empty scopes list from the file as written', async () => {
    const outcome = await loadedFile('', [...OAUTH2_LINES.slice(0, -1), 'scopes = []', '']);
    expect(outcome).toEqual({ password: '', oauth2: { ...fileOAuth2, scopes: [] } });
  });

  it('should refuse an empty password without OAuth2, naming the missing credential', async () => {
    expect(await loadedFile('', [])).toEqual({
      refused: ['accounts.0: Either password or oauth2 config is required'],
    });
  });
});
