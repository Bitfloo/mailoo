import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseTOML } from 'smol-toml';

import persistAlerts from './alerts-config.js';

/** A config the setup wizard writes, plus a hooks rule and a private-webhook opt-in. */
const CONFIG = `
[settings]
rate_limit = 7

[settings.hooks]
on_new_email = "notify"

[[settings.hooks.rules]]
name = "invoices"
match = { from = "*@example.com" }
actions = { labels = ["Finance"] }

[settings.hooks.alerts]
desktop = false
allow_private_webhooks = true

[[accounts]]
name = "personal"
email = "me@example.com"
password = "test-only-password"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

const UPDATED = {
  desktop: true,
  sound: true,
  urgencyThreshold: 'normal' as const,
  webhookUrl: 'https://hooks.example.com/alerts',
  webhookEvents: ['urgent' as const, 'normal' as const],
};

describe('persistAlerts', () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-alerts-config-'));
    configPath = path.join(dir, 'config.toml');
    await fs.writeFile(configPath, CONFIG, 'utf-8');
    // Owner-only like the wizard writes it; looser modes print a warning on load.
    await fs.chmod(configPath, 0o600);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function saved(): Promise<Record<string, unknown>> {
    return parseTOML(await fs.readFile(configPath, 'utf-8'));
  }

  it('should write the alert settings under settings.hooks.alerts', async () => {
    await persistAlerts(UPDATED, configPath);

    const { settings } = (await saved()) as { settings: { hooks: { alerts: unknown } } };

    expect(settings.hooks.alerts).toEqual({
      desktop: true,
      sound: true,
      urgency_threshold: 'normal',
      webhook_url: 'https://hooks.example.com/alerts',
      webhook_events: ['urgent', 'normal'],
      allow_private_webhooks: true,
    });
  });

  it('should keep the accounts, rules and other settings', async () => {
    await persistAlerts(UPDATED, configPath);

    const config = (await saved()) as {
      accounts: { name: string }[];
      settings: { rate_limit: number; hooks: { rules: { name: string }[] } };
    };

    expect({
      accounts: config.accounts.map((a) => a.name),
      rateLimit: config.settings.rate_limit,
      rules: config.settings.hooks.rules.map((r) => r.name),
    }).toEqual({ accounts: ['personal'], rateLimit: 7, rules: ['invoices'] });
  });

  it('should reject when there is no config file', async () => {
    const missing = path.join(dir, 'absent.toml');

    await expect(persistAlerts(UPDATED, missing)).rejects.toThrow(/No config file found/);
  });
});
