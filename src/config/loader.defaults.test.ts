import path from 'node:path';

import { useConfigSandbox, writeOwnerOnly } from '../test-support/config-sandbox.js';
import type { AppConfig } from '../types/index.js';
import { loadConfig } from './loader.js';
import { ImapConfigSchema, SettingsSchema, SmtpConfigSchema } from './schema.js';

/** snake_case keys renamed to camelCase at every depth, the shape AppConfig uses. */
function camelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase()),
      camelKeys(inner),
    ]),
  );
}

// Defaults were written out in the schema, again in the env loader and
// again in normalization; one copy drifting changed behaviour by source.
describe('defaults shared by the env and TOML paths', () => {
  const sandbox = useConfigSandbox();

  const ENV_ACCOUNT = {
    MCP_EMAIL_ADDRESS: 'env@example.com',
    MCP_EMAIL_PASSWORD: 'env-pass',
    MCP_EMAIL_IMAP_HOST: 'imap.example.com',
    MCP_EMAIL_SMTP_HOST: 'smtp.example.com',
  };

  const TOML_ACCOUNT = `
[[accounts]]
name = "default"
email = "env@example.com"
password = "env-pass"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

  function stubEnv(vars: Record<string, string>): void {
    Object.entries(vars).forEach(([key, value]) => {
      vi.stubEnv(key, value);
    });
  }

  it('should give env-only setup the same config as a TOML file with the same account', async () => {
    const configPath = path.join(sandbox.dir, 'config.toml');
    await writeOwnerOnly(configPath, TOML_ACCOUNT);
    const fromFile = await loadConfig(configPath);
    stubEnv(ENV_ACCOUNT);

    const fromEnv = await loadConfig(path.join(sandbox.dir, 'nonexistent.toml'));

    expect(fromEnv).toEqual(fromFile);
  });

  // The values are pinned in schema.test.ts and loader.test.ts; this checks
  // only that the loader carries every one through under its camelCase name.
  it('should carry every schema default into the config when the TOML file has only an account', async () => {
    const configPath = path.join(sandbox.dir, 'config.toml');
    await writeOwnerOnly(configPath, TOML_ACCOUNT);

    const config = await loadConfig(configPath);

    expect({
      settings: config.settings,
      imap: config.accounts[0].imap,
      smtp: config.accounts[0].smtp,
    }).toEqual(
      camelKeys({
        settings: SettingsSchema.parse({}),
        imap: ImapConfigSchema.parse({ host: 'imap.example.com' }),
        smtp: SmtpConfigSchema.parse({ host: 'smtp.example.com' }),
      }),
    );
  });

  it('should carry each MCP_EMAIL_* setting through when it is set', async () => {
    stubEnv({
      ...ENV_ACCOUNT,
      MCP_EMAIL_ACCOUNT_NAME: 'work',
      MCP_EMAIL_FULL_NAME: 'Env User',
      MCP_EMAIL_USERNAME: 'env-login',
      MCP_EMAIL_RATE_LIMIT: '3',
      MCP_EMAIL_READ_ONLY: 'true',
      MCP_EMAIL_SAVE_TO_SENT: 'false',
      MCP_EMAIL_WATCHER_ENABLED: 'true',
      MCP_EMAIL_WATCHER_FOLDERS: 'INBOX, Work',
      MCP_EMAIL_WATCHER_IDLE_TIMEOUT: '600',
      MCP_EMAIL_HOOK_ON_NEW_EMAIL: 'triage',
      MCP_EMAIL_HOOK_PRESET: 'gtd',
      MCP_EMAIL_HOOK_AUTO_LABEL: 'true',
      MCP_EMAIL_HOOK_AUTO_FLAG: 'true',
      MCP_EMAIL_HOOK_BATCH_DELAY: '9',
      MCP_EMAIL_HOOK_CUSTOM_INSTRUCTIONS: 'Flag invoices',
      MCP_EMAIL_ALERT_DESKTOP: 'true',
      MCP_EMAIL_ALERT_SOUND: 'true',
      MCP_EMAIL_ALERT_URGENCY_THRESHOLD: 'urgent',
      MCP_EMAIL_ALERT_WEBHOOK_URL: 'https://hooks.example.com/mail',
      MCP_EMAIL_ALERT_WEBHOOK_ALLOW_PRIVATE: 'true',
      MCP_EMAIL_HOOK_AUTO_CALENDAR: 'true',
      MCP_EMAIL_HOOK_CALENDAR_NAME: 'Mail',
      MCP_EMAIL_HOOK_CALENDAR_ALARM_MINUTES: '30',
      MCP_EMAIL_HOOK_CALENDAR_CONFIRM: 'false',
      MCP_EMAIL_SYSTEM_ONE_ENABLED: 'true',
      MCP_EMAIL_IMAP_PORT: '143',
      MCP_EMAIL_IMAP_TLS: 'false',
      MCP_EMAIL_IMAP_STARTTLS: 'true',
      MCP_EMAIL_IMAP_VERIFY_SSL: 'false',
      MCP_EMAIL_IMAP_DISABLE_IMAP4REV2: 'true',
      MCP_EMAIL_SIEVE_HOST: 'sieve.example.com',
      MCP_EMAIL_SIEVE_PORT: '4190',
      MCP_EMAIL_SMTP_PORT: '587',
      MCP_EMAIL_SMTP_TLS: 'false',
      MCP_EMAIL_SMTP_STARTTLS: 'true',
      MCP_EMAIL_SMTP_VERIFY_SSL: 'false',
      MCP_EMAIL_SMTP_POOL_ENABLED: 'false',
      MCP_EMAIL_SMTP_POOL_MAX_CONNECTIONS: '4',
      MCP_EMAIL_SMTP_POOL_MAX_MESSAGES: '50',
    });

    const config = await loadConfig(path.join(sandbox.dir, 'nonexistent.toml'));

    expect({
      settings: {
        ...config.settings,
        systemOne: { enabled: config.settings.systemOne.enabled },
      },
      account: config.accounts[0],
    }).toEqual({
      settings: {
        rateLimit: 3,
        readOnly: true,
        saveToSent: false,
        watcher: { enabled: true, folders: ['INBOX', 'Work'], idleTimeout: 600 },
        systemOne: { enabled: true },
        hooks: {
          onNewEmail: 'triage',
          preset: 'gtd',
          autoLabel: true,
          autoFlag: true,
          batchDelay: 9,
          customInstructions: 'Flag invoices',
          rules: [],
          alerts: {
            desktop: true,
            sound: true,
            urgencyThreshold: 'urgent',
            webhookUrl: 'https://hooks.example.com/mail',
            webhookEvents: ['urgent', 'high'],
            allowPrivateWebhooks: true,
          },
          autoCalendar: true,
          calendarName: 'Mail',
          calendarAlarmMinutes: 30,
          calendarConfirm: false,
        },
      },
      account: {
        name: 'work',
        email: 'env@example.com',
        fullName: 'Env User',
        username: 'env-login',
        password: 'env-pass',
        imap: {
          host: 'imap.example.com',
          port: 143,
          tls: false,
          starttls: true,
          verifySsl: false,
          disableImap4rev2: true,
          sieveHost: 'sieve.example.com',
          sievePort: 4190,
        },
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          tls: false,
          starttls: true,
          verifySsl: false,
          pool: { enabled: false, maxConnections: 4, maxMessages: 50 },
        },
      },
    });
  });

  it.each([
    ['MCP_EMAIL_READ_ONLY', '1', (c: AppConfig) => c.settings.readOnly, false],
    ['MCP_EMAIL_SAVE_TO_SENT', '0', (c: AppConfig) => c.settings.saveToSent, true],
    ['MCP_EMAIL_IMAP_TLS', 'no', (c: AppConfig) => c.accounts[0].imap.tls, true],
    [
      'MCP_EMAIL_SMTP_POOL_ENABLED',
      'off',
      (c: AppConfig) => c.accounts[0].smtp.pool?.enabled,
      true,
    ],
  ])(
    'should keep the default when %s is %s rather than true or false',
    async (name, value, read, expected) => {
      stubEnv({ ...ENV_ACCOUNT, [name]: value });

      const config = await loadConfig(path.join(sandbox.dir, 'nonexistent.toml'));

      expect(read(config)).toBe(expected);
    },
  );
});
