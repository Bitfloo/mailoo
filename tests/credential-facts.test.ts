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

  it('should say that the OAuth2 provider replaces the password and needs the three OAuth2 values', () => {
    expect(envVar('MCP_EMAIL_OAUTH2_PROVIDER').description).toBe(
      'OAuth2 provider: google, microsoft, or custom. Replaces MCP_EMAIL_PASSWORD; the OAuth2 client id, client secret, and refresh token are then required.',
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
  it('should reject an account with neither a password nor OAuth2', () => {
    expect(AccountConfigSchema.safeParse(account).success).toBe(false);
  });

  it('should accept an account with only a password', () => {
    expect(AccountConfigSchema.safeParse({ ...account, password: 'app-password' }).success).toBe(
      true,
    );
  });

  it('should accept an account with only OAuth2', () => {
    expect(AccountConfigSchema.safeParse({ ...account, oauth2 }).success).toBe(true);
  });

  // A form that leaves the password field blank can pass an empty string.
  it('should accept an empty password beside OAuth2, which replaces it', () => {
    expect(AccountConfigSchema.safeParse({ ...account, password: '', oauth2 }).success).toBe(true);
  });

  it('should reject an empty password without OAuth2', () => {
    expect(AccountConfigSchema.safeParse({ ...account, password: '' }).success).toBe(false);
  });

  // The password goes to the server verbatim; only the server can say it is wrong.
  it('should accept a whitespace-only password as a credential, since passwords are not trimmed', () => {
    expect(AccountConfigSchema.safeParse({ ...account, password: '   ' }).success).toBe(true);
  });

  describe.each(['client_id', 'client_secret', 'refresh_token'])('OAuth2 %s', (field) => {
    it('should be rejected when empty', () => {
      const partial = { ...oauth2, [field]: '' };
      expect(AccountConfigSchema.safeParse({ ...account, oauth2: partial }).success).toBe(false);
    });

    it('should be rejected when absent', () => {
      const partial: Record<string, string> = { ...oauth2 };
      delete partial[field];
      expect(AccountConfigSchema.safeParse({ ...account, oauth2: partial }).success).toBe(false);
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

  it('should keep OAuth2 when a password is set beside the provider, since the provider replaces it', async () => {
    vi.stubEnv('MCP_EMAIL_PASSWORD', 'app-password');
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.oauth2?.provider).toBe('google');
  });

  // The mirror of the empty password: a form that leaves the provider blank can pass ''.
  it('should load a password account with no OAuth2 when the provider variable is set but empty', async () => {
    vi.stubEnv('MCP_EMAIL_PASSWORD', 'app-password');
    vi.stubEnv('MCP_EMAIL_OAUTH2_PROVIDER', '');
    vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_ID', undefined);
    vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_SECRET', undefined);
    vi.stubEnv('MCP_EMAIL_OAUTH2_REFRESH_TOKEN', undefined);
    const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
    expect(config.accounts[0]?.oauth2).toBeUndefined();
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

  // A blank password field arrives as '', which is no credential either.
  describe.each([
    ['unset', undefined],
    ['set but empty', ''],
  ])('with the password variable %s', (_label, password) => {
    beforeEach(() => {
      vi.stubEnv('MCP_EMAIL_PASSWORD', password);
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
