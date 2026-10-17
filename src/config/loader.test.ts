import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AppConfig } from '../types/index.js';
import { configExists, generateTemplate, loadConfig, loadRawConfig, saveConfig } from './loader.js';

const MINIMAL_TOML = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

/** writeFile follows the umask, usually 0644, which warns on load. */
async function writeOwnerOnly(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, 'utf-8');
  await fs.chmod(filePath, 0o600);
}

const MCP_ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith('MCP_EMAIL_'));

function permissionBits(mode: number): number {
  return mode % 0o1000;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('Config Loader', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-test-'));

    // Save and clear all MCP_EMAIL_* env vars
    for (const key of MCP_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Also clear the standard ones we set in tests
    for (const key of [
      'MCP_EMAIL_ADDRESS',
      'MCP_EMAIL_PASSWORD',
      'MCP_EMAIL_IMAP_HOST',
      'MCP_EMAIL_SMTP_HOST',
      'MCP_EMAIL_READ_ONLY',
      'MCP_EMAIL_ACCOUNT_NAME',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });

    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // -------------------------------------------------------------------------
  // loadConfig from TOML file
  // -------------------------------------------------------------------------

  describe('loadConfig from TOML file', () => {
    it.each([
      { label: '0600', mode: 0o600, warningLines: 0, claim: 'no warning line' },
      { label: '0640', mode: 0o640, warningLines: 1, claim: 'one warning' },
      { label: '0604', mode: 0o604, warningLines: 1, claim: 'one warning' },
    ])('should log $claim when the config mode is $label', async ({ mode, warningLines }) => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
      await fs.chmod(configPath, mode);

      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await loadConfig(configPath);

        const warnings = stderr.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('warning'));
        expect(warnings).toHaveLength(warningLines);
      } finally {
        stderr.mockRestore();
      }
    });

    it('should name chmod 600 and the path in the group-readable warning', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
      await fs.chmod(configPath, 0o644);

      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const config = await loadConfig(configPath);

        expect(config.accounts[0].email).toBe('test@example.com');
        expect(permissionBits((await fs.stat(configPath)).mode)).toBe(0o644);
        const warnings = stderr.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('warning'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(`chmod 600 ${configPath}`);
      } finally {
        stderr.mockRestore();
      }
    });

    it('should load config when the file is a symlink', async () => {
      const real = path.join(tmpDir, 'real.toml');
      await fs.writeFile(real, MINIMAL_TOML, 'utf-8');
      await fs.chmod(real, 0o600);
      const link = path.join(tmpDir, 'link.toml');
      await fs.symlink('real.toml', link);

      const config = await loadConfig(link);

      expect(config.accounts[0].email).toBe('test@example.com');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(link)).toBe('real.toml');
    });

    it('should load config when its directory is a symlink', async () => {
      const realDir = path.join(tmpDir, 'real-dir');
      await fs.mkdir(realDir);
      const realFile = path.join(realDir, 'config.toml');
      await fs.writeFile(realFile, MINIMAL_TOML, 'utf-8');
      await fs.chmod(realFile, 0o644);
      const linkDir = path.join(tmpDir, 'linked-dir');
      await fs.symlink('real-dir', linkDir);

      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const config = await loadConfig(path.join(linkDir, 'config.toml'));

        expect(config.accounts[0].email).toBe('test@example.com');
        expect((await fs.lstat(linkDir)).isSymbolicLink()).toBe(true);
        expect(permissionBits((await fs.stat(realFile)).mode)).toBe(0o644);
      } finally {
        stderr.mockRestore();
      }
    });

    it('loads a valid TOML config file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML);

      const config = await loadConfig(configPath);

      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0].name).toBe('test');
      expect(config.accounts[0].email).toBe('test@example.com');
      expect(config.accounts[0].imap.host).toBe('imap.example.com');
      expect(config.accounts[0].smtp.host).toBe('smtp.example.com');
    });

    it('throws when config file does not exist', async () => {
      const badPath = path.join(tmpDir, 'nonexistent.toml');
      await expect(loadConfig(badPath)).rejects.toThrow('No configuration found');
    });

    it('should treat a directory at the config path as no config file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.mkdir(configPath);

      await expect(loadConfig(configPath)).rejects.toThrow('No configuration found');
    });

    // root bypasses directory permission bits
    it.skipIf(process.getuid?.() === 0)(
      'should reject with EACCES instead of "No configuration found" when the config directory cannot be searched',
      async () => {
        const locked = path.join(tmpDir, 'locked');
        await fs.mkdir(locked);
        await writeOwnerOnly(path.join(locked, 'config.toml'), MINIMAL_TOML);
        await fs.chmod(locked, 0o000);
        try {
          await expect(loadConfig(path.join(locked, 'config.toml'))).rejects.toMatchObject({
            code: 'EACCES',
          });
        } finally {
          await fs.chmod(locked, 0o700);
        }
      },
    );

    it('should name the path when loadRawConfig finds no config file', async () => {
      const badPath = path.join(tmpDir, 'nonexistent.toml');

      await expect(loadRawConfig(badPath)).rejects.toThrow(`No config file found at: ${badPath}`);
    });

    it('should default username to the email when the account sets none', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML);

      const config = await loadConfig(configPath);

      expect(config.accounts[0].username).toBe('test@example.com');
    });

    // A typo used to read as "No configuration found" and point at setup,
    // which can overwrite the file the user only needed to fix.
    it('should name the file, line and column when the TOML has a syntax error', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, `${MINIMAL_TOML}\n[accounts.smtp\n`);

      await expect(loadConfig(configPath)).rejects.toThrow(
        new RegExp(
          `^Config file ${escapeRegExp(configPath)} is not valid TOML \\(line 13, column \\d+\\): `,
        ),
      );
    });

    it('should not point at setup when the TOML has a syntax error', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, `${MINIMAL_TOML}\n[accounts.smtp\n`);

      await expect(loadConfig(configPath)).rejects.not.toThrow(/No configuration found|setup/);
    });

    it('should keep the offending line text out of the TOML syntax error', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML.replace('"secret"', '"hunter2'));

      await expect(loadConfig(configPath)).rejects.not.toThrow(/hunter2/);
    });

    it('should name the file when loadRawConfig meets a TOML syntax error', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, `${MINIMAL_TOML}\n[accounts.smtp\n`);

      await expect(loadRawConfig(configPath)).rejects.toThrow(`Config file ${configPath}`);
    });

    it('normalizes snake_case to camelCase', async () => {
      const toml = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"
verify_ssl = false

[accounts.smtp]
host = "smtp.example.com"
verify_ssl = false

[settings]
rate_limit = 5
read_only = true
`;
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, toml);

      const config = await loadConfig(configPath);

      expect(config.accounts[0].imap.verifySsl).toBe(false);
      expect(config.accounts[0].smtp.verifySsl).toBe(false);
      expect(config.settings.rateLimit).toBe(5);
      expect(config.settings.readOnly).toBe(true);
    });

    it('carries an account sent_mailbox through to sentMailbox', async () => {
      const toml = `
[[accounts]]
name = "ovh"
email = "test@example.com"
password = "secret"
sent_mailbox = "INBOX.Sent Messages"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, toml);

      const config = await loadConfig(configPath);

      expect(config.accounts[0].sentMailbox).toBe('INBOX.Sent Messages');
    });

    it('applies default values for optional fields', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML);

      const config = await loadConfig(configPath);

      // Account defaults
      expect(config.accounts[0].imap.port).toBe(993);
      expect(config.accounts[0].imap.tls).toBe(true);
      expect(config.accounts[0].imap.verifySsl).toBe(true);
      expect(config.accounts[0].smtp.port).toBe(465);
      expect(config.accounts[0].smtp.pool?.enabled).toBe(true);
      expect(config.accounts[0].smtp.pool?.maxConnections).toBe(1);

      // Settings defaults
      expect(config.settings.rateLimit).toBe(10);
      expect(config.settings.readOnly).toBe(false);
      expect(config.settings.watcher.enabled).toBe(false);
      expect(config.settings.watcher.folders).toEqual(['INBOX']);
      expect(config.settings.hooks.onNewEmail).toBe('notify');
      expect(config.settings.hooks.preset).toBe('priority-focus');
      expect(config.settings.systemOne.enabled).toBe(false);
      expect(config.settings.systemOne.autoMove).toBe(false);
      expect(config.settings.systemOne.autoFlag).toBe(false);
      expect(config.settings.hooks.alerts.allowPrivateWebhooks).toBe(false);
      expect(config.settings.systemOne.includeBody).toBe(false);
      expect(config.settings.systemOne.thresholds.isCriticalMin).toBe(0.85);
      expect(config.settings.systemOne.thresholds.injectionHigh).toBe(0.75);
    });

    it('keeps move_to through normalizeHookRule', async () => {
      const toml = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"

[[settings.hooks.rules]]
name = "receipts-vendor"
match = { from = "*@billing.example.com" }
actions = { move_to = "Receipts" }
`;
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, toml);

      const config = await loadConfig(configPath);
      expect(config.settings.hooks.rules[0].actions.moveTo).toBe('Receipts');
    });
  });

  // -------------------------------------------------------------------------
  // loadConfig from environment variables
  // -------------------------------------------------------------------------

  describe('loadConfig from environment variables', () => {
    it('loads config from env vars when set', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.example.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.example.com';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0].email).toBe('env@example.com');
      expect(config.accounts[0].imap.host).toBe('imap.example.com');
      expect(config.accounts[0].smtp.host).toBe('smtp.example.com');
    });

    it('reads read_only from MCP_EMAIL_READ_ONLY', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.example.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.example.com';
      process.env.MCP_EMAIL_READ_ONLY = 'true';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.settings.readOnly).toBe(true);
    });

    it('defaults systemOne.thresholds.injectionHigh to 0.75 on the env path', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.example.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.example.com';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.settings.systemOne.thresholds.injectionHigh).toBe(0.75);
    });

    it('should read the TOML file when the env account has no SMTP host', async () => {
      vi.stubEnv('MCP_EMAIL_ADDRESS', 'env@example.com');
      vi.stubEnv('MCP_EMAIL_PASSWORD', 'env-pass');
      vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML);

      const config = await loadConfig(configPath);

      expect(config.accounts[0].email).toBe('test@example.com');
    });

    it('should build oauth2 from MCP_EMAIL_OAUTH2_* when no password is set', async () => {
      vi.stubEnv('MCP_EMAIL_ADDRESS', 'env@example.com');
      vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
      vi.stubEnv('MCP_EMAIL_SMTP_HOST', 'smtp.example.com');
      vi.stubEnv('MCP_EMAIL_OAUTH2_PROVIDER', 'google');
      vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_ID', 'fake-client-id');
      vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_SECRET', 'fake-client-secret');
      vi.stubEnv('MCP_EMAIL_OAUTH2_REFRESH_TOKEN', 'fake-refresh-token');

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.accounts[0].oauth2).toEqual({
        provider: 'google',
        clientId: 'fake-client-id',
        clientSecret: 'fake-client-secret',
        refreshToken: 'fake-refresh-token',
      });
    });
  });

  // Defaults were written out in the schema, again in the env loader and
  // again in normalization; one copy drifting changed behaviour by source.
  describe('defaults shared by the env and TOML paths', () => {
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

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should give env-only setup the same config as a TOML file with the same account', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, TOML_ACCOUNT);
      const fromFile = await loadConfig(configPath);
      stubEnv(ENV_ACCOUNT);

      const fromEnv = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(fromEnv).toEqual(fromFile);
    });

    it('should apply every schema default when the TOML file has only an account', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await writeOwnerOnly(configPath, TOML_ACCOUNT);

      const config = await loadConfig(configPath);

      expect({
        settings: config.settings,
        imap: config.accounts[0].imap,
        smtp: config.accounts[0].smtp,
      }).toEqual({
        settings: {
          rateLimit: 10,
          readOnly: false,
          saveToSent: true,
          watcher: { enabled: false, folders: ['INBOX'], idleTimeout: 1740 },
          systemOne: {
            enabled: false,
            model: 'jev-latest',
            includeBody: false,
            bodyMaxChars: 6000,
            autoMove: false,
            autoFlag: false,
            folders: [],
            sourceFolders: ['INBOX'],
            thresholds: {
              folderFitMin: 0.85,
              spamHigh: 0.72,
              spamUncertainLow: 0.4,
              spamUncertainHigh: 0.6,
              injectionHigh: 0.75,
              importanceFlagMin: 3,
              importanceMinConfidence: 0.7,
              isCriticalMin: 0.85,
            },
          },
          hooks: {
            onNewEmail: 'notify',
            preset: 'priority-focus',
            autoLabel: false,
            autoFlag: false,
            batchDelay: 5,
            rules: [],
            alerts: {
              desktop: false,
              sound: false,
              urgencyThreshold: 'high',
              webhookUrl: '',
              webhookEvents: ['urgent', 'high'],
              allowPrivateWebhooks: false,
            },
            autoCalendar: false,
            calendarName: '',
            calendarAlarmMinutes: 15,
            calendarConfirm: true,
          },
        },
        imap: {
          host: 'imap.example.com',
          port: 993,
          tls: true,
          starttls: false,
          verifySsl: true,
          disableImap4rev2: false,
        },
        smtp: {
          host: 'smtp.example.com',
          port: 465,
          tls: true,
          starttls: false,
          verifySsl: true,
          pool: { enabled: true, maxConnections: 1, maxMessages: 100 },
        },
      });
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

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

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

        const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

        expect(read(config)).toBe(expected);
      },
    );
  });

  // -------------------------------------------------------------------------
  // saveConfig
  // -------------------------------------------------------------------------

  describe('saveConfig', () => {
    it('saves config as TOML and can be re-read', async () => {
      const configPath = path.join(tmpDir, 'saved.toml');

      // Write minimal TOML first, load it as raw, then save and re-load
      const srcPath = path.join(tmpDir, 'source.toml');
      await writeOwnerOnly(srcPath, MINIMAL_TOML);
      await loadConfig(srcPath);

      // Build a RawAppConfig to save
      const rawConfig = {
        accounts: [
          {
            name: 'saved-test',
            email: 'saved@example.com',
            password: 'saved-pass',
            imap: { host: 'imap.saved.com' },
            smtp: { host: 'smtp.saved.com' },
          },
        ],
      };

      await saveConfig(rawConfig as unknown as Parameters<typeof saveConfig>[0], configPath);

      const reloaded = await loadConfig(configPath);
      expect(reloaded.accounts[0].name).toBe('saved-test');
      expect(reloaded.accounts[0].email).toBe('saved@example.com');
      expect(reloaded.accounts[0].imap.host).toBe('imap.saved.com');
    });

    it('writes the file as owner-only and the parent directory as owner-only', async () => {
      const dir = path.join(tmpDir, 'cfg');
      const configPath = path.join(dir, 'config.toml');
      const rawConfig = {
        accounts: [
          {
            name: 'saved-test',
            email: 'saved@example.com',
            password: 'saved-pass',
            imap: { host: 'imap.saved.com' },
            smtp: { host: 'smtp.saved.com' },
          },
        ],
      };

      await saveConfig(rawConfig as unknown as Parameters<typeof saveConfig>[0], configPath);

      expect(permissionBits((await fs.stat(configPath)).mode)).toBe(0o600);
      expect(permissionBits((await fs.stat(dir)).mode)).toBe(0o700);
    });

    it('should keep a symlinked config file and update its target', async () => {
      const store = path.join(tmpDir, 'store');
      await fs.mkdir(store);
      const target = path.join(store, 'target.toml');
      await fs.writeFile(target, 'original');
      const linkDir = path.join(tmpDir, 'links');
      await fs.mkdir(linkDir);
      const configPath = path.join(linkDir, 'config.toml');
      const linkText = path.relative(linkDir, target);
      await fs.symlink(linkText, configPath);
      // The link's directory cannot hold a temp file. The write has to
      // rename inside the directory that contains the target.
      await fs.chmod(linkDir, 0o555);
      const rawConfig = {
        accounts: [
          {
            name: 'saved-test',
            email: 'saved@example.com',
            password: 'saved-pass',
            imap: { host: 'imap.saved.com' },
            smtp: { host: 'smtp.saved.com' },
          },
        ],
      };
      const inodeBefore = (await fs.stat(target)).ino;

      try {
        await saveConfig(rawConfig as unknown as Parameters<typeof saveConfig>[0], configPath);

        expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
        expect(await fs.readlink(configPath)).toBe(linkText);
        expect(await fs.readFile(target, 'utf-8')).toContain('saved-test');
        expect(permissionBits((await fs.stat(target)).mode)).toBe(0o600);
        expect((await fs.stat(target)).ino).not.toBe(inodeBefore);
        expect(permissionBits((await fs.stat(linkDir)).mode)).toBe(0o555);
        expect((await fs.readdir(store)).some((name) => name.endsWith('.tmp'))).toBe(false);
      } finally {
        await fs.chmod(linkDir, 0o700);
      }
    });

    it('should write through a symlinked directory without replacing the link', async () => {
      const realDir = path.join(tmpDir, 'real');
      await fs.mkdir(realDir, { mode: 0o755 });
      await fs.chmod(realDir, 0o755);
      const link = path.join(tmpDir, 'linked');
      await fs.symlink('real', link);
      const rawConfig = {
        accounts: [
          {
            name: 'saved-test',
            email: 'saved@example.com',
            password: 'saved-pass',
            imap: { host: 'imap.saved.com' },
            smtp: { host: 'smtp.saved.com' },
          },
        ],
      };

      await saveConfig(
        rawConfig as unknown as Parameters<typeof saveConfig>[0],
        path.join(link, 'config.toml'),
      );

      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(link)).toBe('real');
      expect(permissionBits((await fs.stat(realDir)).mode)).toBe(0o755);
      const written = path.join(realDir, 'config.toml');
      expect(permissionBits((await fs.stat(written)).mode)).toBe(0o600);
      expect(await fs.readFile(written, 'utf-8')).toContain('saved-test');
    });

    it('should leave the mode of an existing directory unchanged', async () => {
      const dir = path.join(tmpDir, 'cfg');
      await fs.mkdir(dir, { mode: 0o755 });
      await fs.chmod(dir, 0o755);
      const rawConfig = {
        accounts: [
          {
            name: 'saved-test',
            email: 'saved@example.com',
            password: 'saved-pass',
            imap: { host: 'imap.saved.com' },
            smtp: { host: 'smtp.saved.com' },
          },
        ],
      };

      await saveConfig(
        rawConfig as unknown as Parameters<typeof saveConfig>[0],
        path.join(dir, 'config.toml'),
      );

      expect(permissionBits((await fs.stat(dir)).mode)).toBe(0o755);
      expect(permissionBits((await fs.stat(path.join(dir, 'config.toml'))).mode)).toBe(0o600);
    });

    it('rejects a config path that contains a null byte', async () => {
      const rawConfig = {
        accounts: [
          {
            name: 'saved-test',
            email: 'saved@example.com',
            password: 'saved-pass',
            imap: { host: 'imap.saved.com' },
            smtp: { host: 'smtp.saved.com' },
          },
        ],
      };

      await expect(
        saveConfig(rawConfig as unknown as Parameters<typeof saveConfig>[0], 'bad\0.toml'),
      ).rejects.toThrow(/not valid/);
    });

    describe('temp file', () => {
      const RAW_CONFIG = {
        accounts: [
          {
            name: 'saved-test',
            email: 'saved@example.com',
            password: 'saved-pass',
            imap: { host: 'imap.saved.com' },
            smtp: { host: 'smtp.saved.com' },
          },
        ],
      } as unknown as Parameters<typeof saveConfig>[0];

      function staleTempPath(): string {
        return path.join(tmpDir, `.config.toml.${process.pid}.tmp`);
      }

      // The temp file holds the whole config, passwords included.
      it('should leave no temp file behind when replacing the config fails', async () => {
        const configPath = path.join(tmpDir, 'config.toml');
        await writeOwnerOnly(configPath, MINIMAL_TOML);
        vi.spyOn(fs, 'rename').mockRejectedValueOnce(
          Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' }),
        );

        const outcome = await saveConfig(RAW_CONFIG, configPath).then(
          () => 'saved',
          (error: Error) => error.message,
        );

        expect({ outcome, entries: await fs.readdir(tmpDir) }).toEqual({
          outcome: 'cross-device link not permitted',
          entries: ['config.toml'],
        });
      });

      it('should save over a stale temp file left by an earlier process with the same pid', async () => {
        const configPath = path.join(tmpDir, 'config.toml');
        await fs.writeFile(staleTempPath(), 'stale');

        await saveConfig(RAW_CONFIG, configPath);

        expect(await fs.readFile(configPath, 'utf-8')).toContain('saved-test');
      });

      it('should remove a stale temp symlink without writing to its target', async () => {
        const decoy = path.join(tmpDir, 'decoy.txt');
        await fs.writeFile(decoy, 'decoy');
        await fs.symlink(decoy, staleTempPath());

        await saveConfig(RAW_CONFIG, path.join(tmpDir, 'config.toml'));

        expect(await fs.readFile(decoy, 'utf-8')).toBe('decoy');
      });
    });
  });

  // -------------------------------------------------------------------------
  // configExists
  // -------------------------------------------------------------------------

  describe('configExists', () => {
    it('returns true for existing file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      expect(await configExists(configPath)).toBe(true);
    });

    it('returns false for non-existing file', async () => {
      const badPath = path.join(tmpDir, 'nope.toml');

      expect(await configExists(badPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // generateTemplate
  // -------------------------------------------------------------------------

  describe('generateTemplate', () => {
    it('returns valid TOML template string', () => {
      const template = generateTemplate();

      expect(typeof template).toBe('string');
      expect(template).toContain('[[accounts]]');
      expect(template).toContain('[accounts.imap]');
      expect(template).toContain('[accounts.smtp]');
      expect(template).toContain('[settings]');
      expect(template).toContain('rate_limit');
      expect(template).toContain('[settings.system_one]');
      expect(template).not.toContain('TYPESAFE_API_KEY =');
    });
  });
});
