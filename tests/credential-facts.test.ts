/**
 * The credential an account needs, as the registry listing describes it and
 * as the account schema and the MCP_EMAIL_* loader enforce it.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config/loader.js';
import { AccountConfigSchema, OAuth2ConfigSchema } from '../src/config/schema.js';
import { repoRoot } from './agents/agent-file.js';

interface EnvVar {
  name: string;
  description: string;
  isRequired: boolean;
}

const server = JSON.parse(readFileSync(join(repoRoot, 'server.json'), 'utf8')) as {
  packages: { environmentVariables: EnvVar[] }[];
};
const envVar = (name: string): EnvVar => {
  const found = server.packages[0]?.environmentVariables.find((item) => item.name === name);
  if (found === undefined) throw new Error(`server.json does not declare ${name}`);
  return found;
};
const account = {
  name: 'work',
  email: 'owner@example.com',
  imap: { host: 'imap.example.com' },
  smtp: { host: 'smtp.example.com' },
};
const oauth2 = {
  provider: 'google',
  client_id: 'id',
  client_secret: 'secret',
  refresh_token: 'refresh',
};

describe('server.json credential requirement', () => {
  // The registry schema has no "one of" for inputs, so neither credential is
  // isRequired; the descriptions have to say that one of them is.
  // src/identity.test.ts checks that smithery.yaml copies these descriptions.
  it.each(['MCP_EMAIL_PASSWORD', 'MCP_EMAIL_OAUTH2_PROVIDER'])(
    'should leave %s optional, since either credential is enough',
    (name) => {
      expect(envVar(name).isRequired).toBe(false);
    },
  );

  it('should say that the password is one of two credentials, the other being OAuth2', () => {
    expect(envVar('MCP_EMAIL_PASSWORD').description).toBe(
      'Password or app password. Each account needs one credential: this password, or OAuth2 through MCP_EMAIL_OAUTH2_PROVIDER.',
    );
  });

  it('should say that the OAuth2 provider takes precedence over the password and needs the three OAuth2 values', () => {
    expect(envVar('MCP_EMAIL_OAUTH2_PROVIDER').description).toBe(
      'OAuth2 provider: google, microsoft, or custom. Takes precedence over MCP_EMAIL_PASSWORD. The OAuth2 client id, client secret, and refresh token are then required.',
    );
  });

  it('should name exactly the OAuth2 providers the config accepts', () => {
    const named = /^OAuth2 provider: ([a-z, ]+)./
      .exec(envVar('MCP_EMAIL_OAUTH2_PROVIDER').description)?.[1]
      ?.split(/, (?:or )?/);
    expect(named).toEqual(OAuth2ConfigSchema.shape.provider.options);
  });

  it.each([
    'MCP_EMAIL_OAUTH2_CLIENT_ID',
    'MCP_EMAIL_OAUTH2_CLIENT_SECRET',
    'MCP_EMAIL_OAUTH2_REFRESH_TOKEN',
  ])('should describe %s as required once a provider is set', (name) => {
    expect(envVar(name).description).toMatch(
      /\. Required when MCP_EMAIL_OAUTH2_PROVIDER is set\.$/,
    );
  });
});

describe('account schema credential', () => {
  it('should reject an account with neither a password nor OAuth2, naming the missing credential', () => {
    const issues = AccountConfigSchema.safeParse(account).error?.issues ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      'Either password or oauth2 config is required',
    ]);
  });

  it('should accept an account with only a password', () => {
    expect(AccountConfigSchema.safeParse({ ...account, password: 'app-password' }).success).toBe(
      true,
    );
  });

  it('should accept a one-character password', () => {
    expect(AccountConfigSchema.safeParse({ ...account, password: 'x' }).success).toBe(true);
  });

  it('should accept an account with only OAuth2', () => {
    expect(AccountConfigSchema.safeParse({ ...account, oauth2 }).success).toBe(true);
  });

  // A JSON client config or `docker -e MCP_EMAIL_PASSWORD=` can pass an empty string;
  // Smithery drops blank fields before launch.
  it('should accept an empty password beside OAuth2', () => {
    expect(AccountConfigSchema.safeParse({ ...account, password: '', oauth2 }).success).toBe(true);
  });

  it('should reject an empty password without OAuth2, naming the missing credential', () => {
    const issues = AccountConfigSchema.safeParse({ ...account, password: '' }).error?.issues ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      'Either password or oauth2 config is required',
    ]);
  });

  // The password goes to the server verbatim; only the server can say it is wrong.
  it('should accept a whitespace-only password as a credential, since passwords are not trimmed', () => {
    expect(AccountConfigSchema.safeParse({ ...account, password: '   ' }).success).toBe(true);
  });

  it('should reject OAuth2 without a provider, at oauth2.provider', () => {
    const { provider: _provider, ...rest } = oauth2;
    const issues = AccountConfigSchema.safeParse({ ...account, oauth2: rest }).error?.issues ?? [];
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['oauth2.provider']);
  });

  it.each(['token_url', 'auth_url'])('should reject an OAuth2 %s that is not a URL', (field) => {
    const partial = { ...oauth2, [field]: 'not a url' };
    const issues =
      AccountConfigSchema.safeParse({ ...account, oauth2: partial }).error?.issues ?? [];
    expect(issues.map((issue) => issue.path.join('.'))).toEqual([`oauth2.${field}`]);
  });

  describe.each(['client_id', 'client_secret', 'refresh_token'])('OAuth2 %s', (field) => {
    // Like the password, these go to the provider as given: padded, blank or one character.
    it.each(['  v  ', '   ', 'x'])('should be kept as given when it is %j', (value) => {
      const parsed = AccountConfigSchema.parse({
        ...account,
        oauth2: { ...oauth2, [field]: value },
      });
      expect(parsed.oauth2?.[field as 'client_id']).toBe(value);
    });

    it('should be rejected at its own path when empty', () => {
      const partial = { ...oauth2, [field]: '' };
      const issues =
        AccountConfigSchema.safeParse({ ...account, oauth2: partial }).error?.issues ?? [];
      expect(issues.map((issue) => issue.path.join('.'))).toEqual([`oauth2.${field}`]);
    });

    it('should be rejected at its own path when absent', () => {
      const partial: Record<string, string> = { ...oauth2 };
      delete partial[field];
      const issues =
        AccountConfigSchema.safeParse({ ...account, oauth2: partial }).error?.issues ?? [];
      expect(issues.map((issue) => issue.path.join('.'))).toEqual([`oauth2.${field}`]);
    });
  });
});

describe('MCP_EMAIL_* OAuth2 account from the environment', () => {
  beforeEach(() => {
    server.packages[0]?.environmentVariables.forEach((item) => {
      vi.stubEnv(item.name, undefined);
    });
    vi.stubEnv('MCP_EMAIL_ADDRESS', 'owner@example.com');
    vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
    vi.stubEnv('MCP_EMAIL_SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('MCP_EMAIL_OAUTH2_PROVIDER', 'google');
    vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_ID', 'env-client-id');
    vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_SECRET', 'env-client-secret');
    vi.stubEnv('MCP_EMAIL_OAUTH2_REFRESH_TOKEN', 'env-refresh-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['clientId', 'env-client-id'],
    ['clientSecret', 'env-client-secret'],
    ['refreshToken', 'env-refresh-token'],
  ])('should read oauth2.%s from its own variable', async (key, value) => {
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.oauth2?.[key as 'clientId']).toBe(value);
  });

  it.each(
    [
      ['clientId', 'MCP_EMAIL_OAUTH2_CLIENT_ID'],
      ['clientSecret', 'MCP_EMAIL_OAUTH2_CLIENT_SECRET'],
      ['refreshToken', 'MCP_EMAIL_OAUTH2_REFRESH_TOKEN'],
    ].flatMap(([key, name]) => ['  padded  ', '   ', 'x'].map((value) => [key, name, value])),
  )('should read oauth2.%s from %s verbatim when it is %j', async (key, name, value) => {
    vi.stubEnv(name, value);
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.oauth2?.[key as 'clientId']).toBe(value);
  });

  it.each(OAuth2ConfigSchema.shape.provider.options)(
    'should read oauth2.provider %s from MCP_EMAIL_OAUTH2_PROVIDER',
    async (provider) => {
      vi.stubEnv('MCP_EMAIL_OAUTH2_PROVIDER', provider);
      const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
      expect(config.accounts[0]?.oauth2?.provider).toBe(provider);
    },
  );

  it.each([
    ['MCP_EMAIL_OAUTH2_CLIENT_ID', 'OAuth2 client_id is required'],
    ['MCP_EMAIL_OAUTH2_CLIENT_SECRET', 'OAuth2 client_secret is required'],
    ['MCP_EMAIL_OAUTH2_REFRESH_TOKEN', 'OAuth2 refresh_token is required'],
  ])('should refuse to load when the provider is set and %s is not', async (name, message) => {
    vi.stubEnv(name, undefined);
    await expect(loadConfig(join(repoRoot, 'no-such-config.toml'))).rejects.toThrow(message);
  });

  it('should carry the password of a password-only account', async () => {
    vi.stubEnv('MCP_EMAIL_PASSWORD', 'app-password');
    vi.stubEnv('MCP_EMAIL_OAUTH2_PROVIDER', undefined);
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.password).toBe('app-password');
  });

  it('should load a whitespace-only password verbatim as the credential', async () => {
    vi.stubEnv('MCP_EMAIL_PASSWORD', '   ');
    vi.stubEnv('MCP_EMAIL_OAUTH2_PROVIDER', undefined);
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.password).toBe('   ');
  });

  it('should load the account with no password set', async () => {
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.password).toBeUndefined();
  });

  it('should pass the OAuth2 account through when a password is set beside the provider', async () => {
    vi.stubEnv('MCP_EMAIL_PASSWORD', 'app-password');
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.oauth2?.provider).toBe('google');
  });

  // The mirror of the empty password: a launcher that keeps blank fields can pass ''.
  it('should load a password account with no OAuth2 when the provider variable is set but empty', async () => {
    vi.stubEnv('MCP_EMAIL_PASSWORD', 'app-password');
    vi.stubEnv('MCP_EMAIL_OAUTH2_PROVIDER', '');
    vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_ID', undefined);
    vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_SECRET', undefined);
    vi.stubEnv('MCP_EMAIL_OAUTH2_REFRESH_TOKEN', undefined);
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.oauth2).toBeUndefined();
  });

  it.each(['  pass  ', '   '])(
    'should keep the padded password %j set beside the provider verbatim',
    async (password) => {
      vi.stubEnv('MCP_EMAIL_PASSWORD', password);
      const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
      expect(config.accounts[0]?.password).toBe(password);
    },
  );

  it('should keep a password set beside the provider as given', async () => {
    vi.stubEnv('MCP_EMAIL_PASSWORD', 'app-password');
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.password).toBe('app-password');
  });

  it('should keep an empty password set beside the provider as given', async () => {
    vi.stubEnv('MCP_EMAIL_PASSWORD', '');
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.password).toBe('');
  });

  it('should load the account when the password variable is set but empty', async () => {
    vi.stubEnv('MCP_EMAIL_PASSWORD', '');
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.oauth2?.provider).toBe('google');
  });
});

describe('MCP_EMAIL_* account with no credential', () => {
  let dir: string;

  beforeEach(async () => {
    server.packages[0]?.environmentVariables.forEach((item) => {
      vi.stubEnv(item.name, undefined);
    });
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

    it('should report that no configuration was found when there is no config file', async () => {
      await expect(loadConfig(join(dir, 'missing.toml'))).rejects.toThrow('No configuration found');
    });
  });
});

describe('OAuth2 account from the config file', () => {
  let dir: string;

  beforeEach(async () => {
    server.packages[0]?.environmentVariables.forEach((item) => {
      vi.stubEnv(item.name, undefined);
    });
    dir = await mkdtemp(join(tmpdir(), 'credential-facts-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('should map every OAuth2 field of a custom provider', async () => {
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
  });
});
