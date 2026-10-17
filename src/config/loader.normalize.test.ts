import path from 'node:path';

import { MINIMAL_TOML, useConfigSandbox, writeOwnerOnly } from '../test-support/config-sandbox.js';
import { loadConfig } from './loader.js';

describe('Config Loader', () => {
  const sandbox = useConfigSandbox();

  describe('loadConfig from TOML file', () => {
    it('should default username to the email when the account sets none', async () => {
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, MINIMAL_TOML);

      const config = await loadConfig(configPath);

      expect(config.accounts[0].username).toBe('test@example.com');
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
      const configPath = path.join(sandbox.dir, 'config.toml');
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
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, toml);

      const config = await loadConfig(configPath);

      expect(config.accounts[0].sentMailbox).toBe('INBOX.Sent Messages');
    });

    it('should keep the scopes and endpoints of a custom OAuth2 provider', async () => {
      const toml = `
[[accounts]]
name = "custom"
email = "test@example.com"

[accounts.oauth2]
provider = "custom"
client_id = "fake-client-id"
client_secret = "fake-client-secret"
refresh_token = "fake-refresh-token"
token_url = "https://auth.example.com/token"
auth_url = "https://auth.example.com/authorize"
scopes = ["https://mail.example.com/imap", "offline_access"]

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, toml);

      const config = await loadConfig(configPath);

      expect(config.accounts[0].oauth2).toEqual({
        provider: 'custom',
        clientId: 'fake-client-id',
        clientSecret: 'fake-client-secret',
        refreshToken: 'fake-refresh-token',
        tokenUrl: 'https://auth.example.com/token',
        authUrl: 'https://auth.example.com/authorize',
        scopes: ['https://mail.example.com/imap', 'offline_access'],
      });
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
      const configPath = path.join(sandbox.dir, 'config.toml');
      await writeOwnerOnly(configPath, toml);

      const config = await loadConfig(configPath);
      expect(config.settings.hooks.rules[0].actions.moveTo).toBe('Receipts');
    });
  });
});
