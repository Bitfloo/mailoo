import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { configExists, generateTemplate, loadConfig, saveConfig } from './loader.js';

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
      'EROFS',
      'EPERM',
    ])('should load a group-readable config and warn when chmod throws %s', async (code) => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
      await fs.chmod(configPath, 0o644);

      // A read-only mount (EROFS) or a file owned by another uid (EPERM)
      // rejects chmod. Startup must still read the file.
      const chmod = vi
        .spyOn(fs, 'chmod')
        .mockRejectedValue(Object.assign(new Error(code), { code }));
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
        chmod.mockRestore();
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
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0].email).toBe('env@example.com');
      expect(config.accounts[0].imap.host).toBe('imap.env.com');
      expect(config.accounts[0].smtp.host).toBe('smtp.env.com');
    });

    it('reads read_only from MCP_EMAIL_READ_ONLY', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';
      process.env.MCP_EMAIL_READ_ONLY = 'true';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.settings.readOnly).toBe(true);
    });

    it('defaults systemOne.thresholds.injectionHigh to 0.75 on the env path', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.settings.systemOne.thresholds.injectionHigh).toBe(0.75);
    });
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

    it('does not follow a symlink at the config path', async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cfg-'));
      const outside = path.join(outsideDir, 'target.toml');
      await fs.writeFile(outside, 'original');
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.symlink(outside, configPath);
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

      try {
        await expect(
          saveConfig(rawConfig as unknown as Parameters<typeof saveConfig>[0], configPath),
        ).rejects.toThrow(/symlink/);
        expect(await fs.readFile(outside, 'utf-8')).toBe('original');
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('does not follow a symlinked parent directory', async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cfg-'));
      const link = path.join(tmpDir, 'linked');
      await fs.symlink(outsideDir, link);
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

      try {
        await expect(
          saveConfig(
            rawConfig as unknown as Parameters<typeof saveConfig>[0],
            path.join(link, 'config.toml'),
          ),
        ).rejects.toThrow(/symlink/);
        expect(await fs.readdir(outsideDir)).toEqual([]);
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
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
