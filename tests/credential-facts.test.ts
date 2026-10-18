/**
 * The credential an account needs, as the registry listing describes it and
 * as the account schema and the MCP_EMAIL_* loader enforce it.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ZodError } from 'zod';

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

  it('should reject an empty password without OAuth2, naming the missing credential', () => {
    const issues = AccountConfigSchema.safeParse({ ...account, password: '' }).error?.issues ?? [];
    expect(issues.map((issue) => issue.message)).toEqual([
      'Either password or oauth2 config is required',
    ]);
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
const VALUES = [
  ['unset', undefined],
  ['empty', ''],
  ['blank', '   '],
  ['padded', ' x '],
  ['short', 'x'],
] as const;
type Kind = (typeof VALUES)[number][0];
// The provider must name one exactly, so its padded and short values are near misses.
const PROVIDER_VALUES = [
  ['unset', undefined],
  ['empty', ''],
  ['blank', '   '],
  ['padded', ' google '],
  ['short', 'Google'],
] as const;
const CLIENT_FIELDS = [
  ['client_id', 'clientId', 'MCP_EMAIL_OAUTH2_CLIENT_ID'],
  ['client_secret', 'clientSecret', 'MCP_EMAIL_OAUTH2_CLIENT_SECRET'],
  ['refresh_token', 'refreshToken', 'MCP_EMAIL_OAUTH2_REFRESH_TOKEN'],
] as const;
const PROVIDER_REFUSAL = OAuth2ConfigSchema.shape.provider.safeParse('?').error?.issues[0]?.message;

type Outcome = { password: string | undefined; oauth2: unknown } | { refused: string[] };

describe('account schema credential matrix', () => {
  const parsed = (input: object): Outcome => {
    const result = AccountConfigSchema.safeParse(input);
    if (result.success) return { password: result.data.password, oauth2: result.data.oauth2 };
    return { refused: result.error.issues.map((issue) => issue.path.join('.') || '(account)') };
  };

  const passwordAlone: Record<Kind, 'refused' | 'kept'> = {
    unset: 'refused',
    empty: 'refused',
    blank: 'kept',
    padded: 'kept',
    short: 'kept',
  };
  it.each(VALUES)('password %s (%j) without OAuth2', (kind, password) => {
    expect(parsed({ ...account, password })).toEqual(
      passwordAlone[kind] === 'kept' ? { password, oauth2: undefined } : { refused: ['(account)'] },
    );
  });

  it.each(VALUES)('password %s (%j) beside OAuth2 is kept as given', (_kind, password) => {
    expect(parsed({ ...account, password, oauth2 })).toEqual({ password, oauth2 });
  });

  it.each(PROVIDER_VALUES)('provider %s (%j) is refused at oauth2.provider', (_kind, provider) => {
    expect(parsed({ ...account, oauth2: { ...oauth2, provider } })).toEqual({
      refused: ['oauth2.provider'],
    });
  });

  it.each(OAuth2ConfigSchema.shape.provider.options)('provider %s is accepted', (provider) => {
    expect(parsed({ ...account, oauth2: { ...oauth2, provider } })).toEqual({
      password: undefined,
      oauth2: { ...oauth2, provider },
    });
  });

  const clientValue: Record<Kind, 'refused' | 'kept'> = {
    unset: 'refused',
    empty: 'refused',
    blank: 'kept',
    padded: 'kept',
    short: 'kept',
  };
  it.each(
    CLIENT_FIELDS.flatMap(([field]) =>
      VALUES.map(([kind, value]) => [field, kind, value] as const),
    ),
  )('oauth2.%s %s (%j)', (field, kind, value) => {
    const block: Record<string, string | undefined> = { ...oauth2, [field]: value };
    if (value === undefined) delete block[field];
    expect(parsed({ ...account, oauth2: block })).toEqual(
      clientValue[kind] === 'kept'
        ? { password: undefined, oauth2: block }
        : { refused: [`oauth2.${field}`] },
    );
  });
});

describe('MCP_EMAIL_* credential matrix', () => {
  const fromEnv = {
    provider: 'google',
    clientId: 'env-client-id',
    clientSecret: 'env-client-secret',
    refreshToken: 'env-refresh-token',
  };
  const NO_CONFIG = { refused: ['No configuration found.'] };

  const stub = (vars: Record<string, string | undefined>): void => {
    Object.entries(vars).forEach(([name, value]) => {
      vi.stubEnv(name, value);
    });
  };
  const withOAuth2 = (provider: string | undefined): Record<string, string | undefined> => ({
    MCP_EMAIL_OAUTH2_PROVIDER: provider,
    MCP_EMAIL_OAUTH2_CLIENT_ID: 'env-client-id',
    MCP_EMAIL_OAUTH2_CLIENT_SECRET: 'env-client-secret',
    MCP_EMAIL_OAUTH2_REFRESH_TOKEN: 'env-refresh-token',
  });
  const loaded = async (): Promise<Outcome> => {
    try {
      const config = await loadConfig(join(repoRoot, 'no-such-config.toml'));
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

  beforeEach(() => {
    server.packages[0]?.environmentVariables.forEach((item) => {
      vi.stubEnv(item.name, undefined);
    });
    vi.stubEnv('MCP_EMAIL_ADDRESS', 'owner@example.com');
    vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
    vi.stubEnv('MCP_EMAIL_SMTP_HOST', 'smtp.example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Without a credential the environment describes no account.
  const passwordAlone: Record<Kind, 'none' | 'kept'> = {
    unset: 'none',
    empty: 'none',
    blank: 'kept',
    padded: 'kept',
    short: 'kept',
  };
  it.each(VALUES)('MCP_EMAIL_PASSWORD %s (%j) with no provider', async (kind, password) => {
    stub({ MCP_EMAIL_PASSWORD: password });
    expect(await loaded()).toEqual(
      passwordAlone[kind] === 'kept' ? { password, oauth2: undefined } : NO_CONFIG,
    );
  });

  it.each(VALUES)(
    'MCP_EMAIL_PASSWORD %s (%j) beside a provider is kept as given',
    async (_kind, password) => {
      stub({ ...withOAuth2('google'), MCP_EMAIL_PASSWORD: password });
      expect(await loaded()).toEqual({ password, oauth2: fromEnv });
    },
  );

  const providerAlone: Record<Kind, 'none' | 'refused'> = {
    unset: 'none',
    empty: 'none',
    blank: 'refused',
    padded: 'refused',
    short: 'refused',
  };
  it.each(PROVIDER_VALUES)(
    'MCP_EMAIL_OAUTH2_PROVIDER %s (%j) with no password',
    async (kind, provider) => {
      stub(withOAuth2(provider));
      expect(await loaded()).toEqual(
        providerAlone[kind] === 'none'
          ? NO_CONFIG
          : { refused: [`accounts.0.oauth2.provider: ${PROVIDER_REFUSAL}`] },
      );
    },
  );

  it.each(OAuth2ConfigSchema.shape.provider.options)(
    'MCP_EMAIL_OAUTH2_PROVIDER %s is read as given',
    async (provider) => {
      stub(withOAuth2(provider));
      expect(await loaded()).toEqual({ password: undefined, oauth2: { ...fromEnv, provider } });
    },
  );

  // The OAuth2 values are not read unless the provider names a provider.
  const clientRefusals = CLIENT_FIELDS.map(
    ([field]) => `accounts.0.oauth2.${field}: OAuth2 ${field} is required`,
  );
  const providerBesidePassword: Record<Kind, Outcome> = {
    unset: { password: 'app-password', oauth2: undefined },
    empty: { password: 'app-password', oauth2: undefined },
    blank: { refused: [`accounts.0.oauth2.provider: ${PROVIDER_REFUSAL}`, ...clientRefusals] },
    padded: { refused: [`accounts.0.oauth2.provider: ${PROVIDER_REFUSAL}`, ...clientRefusals] },
    short: { refused: [`accounts.0.oauth2.provider: ${PROVIDER_REFUSAL}`, ...clientRefusals] },
  };
  it.each(PROVIDER_VALUES)(
    'MCP_EMAIL_OAUTH2_PROVIDER %s (%j) beside a password, with no OAuth2 values',
    async (kind, provider) => {
      stub({ MCP_EMAIL_PASSWORD: 'app-password', MCP_EMAIL_OAUTH2_PROVIDER: provider });
      expect(await loaded()).toEqual(providerBesidePassword[kind]);
    },
  );

  it('MCP_EMAIL_OAUTH2_PROVIDER google beside a password, with no OAuth2 values', async () => {
    stub({ MCP_EMAIL_PASSWORD: 'app-password', MCP_EMAIL_OAUTH2_PROVIDER: 'google' });
    expect(await loaded()).toEqual({ refused: clientRefusals });
  });

  const clientValue: Record<Kind, 'refused' | 'kept'> = {
    unset: 'refused',
    empty: 'refused',
    blank: 'kept',
    padded: 'kept',
    short: 'kept',
  };
  it.each(
    CLIENT_FIELDS.flatMap(([field, key, name]) =>
      VALUES.map(([kind, value]) => [name, kind, value, field, key] as const),
    ),
  )('%s %s (%j)', async (name, kind, value, field, key) => {
    stub({ ...withOAuth2('google'), [name]: value });
    expect(await loaded()).toEqual(
      clientValue[kind] === 'kept'
        ? { password: undefined, oauth2: { ...fromEnv, [key]: value } }
        : { refused: [`accounts.0.oauth2.${field}: OAuth2 ${field} is required`] },
    );
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
