import { readFile } from 'node:fs/promises';

import LOOPBACK_HOSTNAMES from '../utils/loopback.js';
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
    'http://[::1]:8080/token',
    'http://localhost:8080/token',
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

  // The README and the rejection message list the hosts in prose; the
  // loopback set is what the check reads.
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
    const loopback = [...LOOPBACK_HOSTNAMES].map((host) => host.replace(/^\[|\]$/g, ''));

    expect((await listedHosts()).sort()).toEqual(loopback.sort());
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
