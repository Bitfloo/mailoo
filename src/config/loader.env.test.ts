import path from 'node:path';

import { MINIMAL_TOML, useConfigSandbox, writeOwnerOnly } from '../test-support/config-sandbox.js';
import { loadConfig } from './loader.js';

describe('Config Loader', () => {
  const sandbox = useConfigSandbox();

  describe('loadConfig from environment variables', () => {
    it('loads config from env vars when set', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.example.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.example.com';

      const config = await loadConfig(path.join(sandbox.dir, 'nonexistent.toml'));

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

      const config = await loadConfig(path.join(sandbox.dir, 'nonexistent.toml'));

      expect(config.settings.readOnly).toBe(true);
    });

    it('defaults systemOne.thresholds.injectionHigh to 0.75 on the env path', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.example.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.example.com';

      const config = await loadConfig(path.join(sandbox.dir, 'nonexistent.toml'));

      expect(config.settings.systemOne.thresholds.injectionHigh).toBe(0.75);
    });

    it('should read the TOML file when the env account has no SMTP host', async () => {
      vi.stubEnv('MCP_EMAIL_ADDRESS', 'env@example.com');
      vi.stubEnv('MCP_EMAIL_PASSWORD', 'env-pass');
      vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML);

      const config = await loadConfig(configPath);

      expect(config.accounts[0].email).toBe('test@example.com');
    });

    it('should load the env account when a config file with another account exists', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML);
      vi.stubEnv('MCP_EMAIL_ADDRESS', 'env@example.com');
      vi.stubEnv('MCP_EMAIL_PASSWORD', 'env-pass');
      vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
      vi.stubEnv('MCP_EMAIL_SMTP_HOST', 'smtp.example.com');

      const config = await loadConfig(configPath);

      expect(config.accounts.map((account) => account.email)).toEqual(['env@example.com']);
    });

    it('should drop empty entries from MCP_EMAIL_WATCHER_FOLDERS', async () => {
      vi.stubEnv('MCP_EMAIL_ADDRESS', 'env@example.com');
      vi.stubEnv('MCP_EMAIL_PASSWORD', 'env-pass');
      vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
      vi.stubEnv('MCP_EMAIL_SMTP_HOST', 'smtp.example.com');
      vi.stubEnv('MCP_EMAIL_WATCHER_FOLDERS', 'INBOX,,Work');

      const config = await loadConfig(path.join(sandbox.dir, 'nonexistent.toml'));

      expect(config.settings.watcher.folders).toEqual(['INBOX', 'Work']);
    });

    it('should build oauth2 from MCP_EMAIL_OAUTH2_* when no password is set', async () => {
      vi.stubEnv('MCP_EMAIL_ADDRESS', 'env@example.com');
      vi.stubEnv('MCP_EMAIL_IMAP_HOST', 'imap.example.com');
      vi.stubEnv('MCP_EMAIL_SMTP_HOST', 'smtp.example.com');
      vi.stubEnv('MCP_EMAIL_OAUTH2_PROVIDER', 'google');
      vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_ID', 'fake-client-id');
      vi.stubEnv('MCP_EMAIL_OAUTH2_CLIENT_SECRET', 'fake-client-secret');
      vi.stubEnv('MCP_EMAIL_OAUTH2_REFRESH_TOKEN', 'fake-refresh-token');

      const config = await loadConfig(path.join(sandbox.dir, 'nonexistent.toml'));

      expect(config.accounts[0].oauth2).toEqual({
        provider: 'google',
        clientId: 'fake-client-id',
        clientSecret: 'fake-client-secret',
        refreshToken: 'fake-refresh-token',
      });
    });
  });
});
