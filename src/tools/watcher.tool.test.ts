import { AppConfigFileSchema } from '../config/schema.js';
import NotifierService from '../services/notifier.service.js';
import { captureConfigureAlerts, hooksConfigFor } from '../test-support/watcher-tool-harness.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

const { loadRawConfig, saveConfig } = vi.hoisted(() => ({
  loadRawConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../config/loader.js', () => ({
  loadRawConfig,
  saveConfig,
}));

describe('configure_alerts', () => {
  const base = {
    desktop: false,
    sound: false,
    urgencyThreshold: 'high' as const,
    webhookUrl: '',
    webhookEvents: ['urgent' as const, 'high' as const],
  };

  beforeEach(() => {
    loadRawConfig.mockReset();
    saveConfig.mockReset();
  });

  it('does not store or persist a webhook URL that contains a line break', async () => {
    const notifier = new NotifierService(base);
    const run = captureConfigureAlerts(notifier);
    const result = await run({
      webhook_url: 'http://hooks.example.com/hook\n',
      save: true,
    });
    expect(result.isError).toBe(true);
    expect(notifier.getConfig().webhookUrl).toBe('');
    expect(saveConfig).not.toHaveBeenCalled();
    notifier.stop();
  });

  it('does not store a webhook URL that contains credentials', async () => {
    const notifier = new NotifierService(base);
    const run = captureConfigureAlerts(notifier);
    const result = await run({
      webhook_url: 'https://user:secret@hooks.example.com/hook',
    });
    expect(result.isError).toBe(true);
    expect(notifier.getConfig().webhookUrl).toBe('');
    notifier.stop();
  });

  it('should reply with the reason when the webhook URL is refused', async () => {
    const notifier = new NotifierService(base);
    const result = await captureConfigureAlerts(notifier)({
      webhook_url: 'https://user:secret@hooks.example.com/hook',
    });
    notifier.stop();
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Failed to update alerts config: Webhook URL must not include credentials',
      },
    ]);
  });

  it('does not store an unknown urgency threshold', async () => {
    const notifier = new NotifierService(base);
    const run = captureConfigureAlerts(notifier);
    const result = await run({ urgency_threshold: 'critical' });
    expect(result.isError).toBe(true);
    expect(notifier.getConfig().urgencyThreshold).toBe('high');
    notifier.stop();
  });

  it('does not store an unknown webhook event', async () => {
    const notifier = new NotifierService(base);
    const run = captureConfigureAlerts(notifier);
    const result = await run({ webhook_events: ['urgent', 'critical'] });
    expect(result.isError).toBe(true);
    expect(notifier.getConfig().webhookEvents).toEqual(['urgent', 'high']);
    notifier.stop();
  });

  it('does not store a webhook URL longer than 2048 characters', async () => {
    const notifier = new NotifierService(base);
    const run = captureConfigureAlerts(notifier);
    const result = await run({
      webhook_url: `https://hooks.example.com/${'a'.repeat(2048)}`,
    });
    expect(result.isError).toBe(true);
    expect(notifier.getConfig().webhookUrl).toBe('');
    notifier.stop();
  });
});

describe('configure_alerts replies and state', () => {
  const base = {
    desktop: false,
    sound: false,
    urgencyThreshold: 'high' as const,
    webhookUrl: '',
    webhookEvents: ['urgent' as const, 'high' as const],
  };

  /** What loadRawConfig returns for a wizard-written file with a private-webhook opt-in. */
  function rawConfig() {
    return AppConfigFileSchema.parse({
      accounts: [
        {
          name: 'personal',
          email: 'me@example.com',
          password: 'test-only-password',
          imap: { host: 'imap.example.com' },
          smtp: { host: 'smtp.example.com' },
        },
      ],
      settings: { hooks: { alerts: { desktop: false, allow_private_webhooks: true } } },
    });
  }

  let notifier: NotifierService;

  beforeEach(() => {
    loadRawConfig.mockReset();
    saveConfig.mockReset();
    notifier = new NotifierService(base);
  });

  afterEach(() => {
    notifier.stop();
  });

  it('should show the current config when no field is given', async () => {
    const result = await captureConfigureAlerts(notifier)({ save: false });

    expect(result.content[0]?.text).toBe(
      'No changes specified. Current config:\n' +
        '  Desktop:   ❌\n' +
        '  Sound:     ❌\n' +
        '  Threshold: high\n' +
        '  Webhook:   (none)\n' +
        '  Events:    urgent, high',
    );
  });

  it('should confirm every setting and the save when save succeeds', async () => {
    loadRawConfig.mockResolvedValue(rawConfig());
    saveConfig.mockResolvedValue(undefined);

    const result = await captureConfigureAlerts(notifier)({
      desktop: true,
      urgency_threshold: 'normal',
      webhook_events: ['urgent'],
      save: true,
    });

    expect(result.content[0]?.text).toBe(
      [
        '✅ Alerts configuration updated:',
        '   Desktop:   ✅ enabled',
        '   Sound:     ❌ disabled',
        '   Threshold: normal',
        '   Webhook:   (none)',
        '   Events:    urgent',
        '',
        '',
        '💾 Changes saved to config file.',
      ].join('\n'),
    );
  });

  it('should write the merged alerts to the config file when save is true', async () => {
    loadRawConfig.mockResolvedValue(rawConfig());
    saveConfig.mockResolvedValue(undefined);

    await captureConfigureAlerts(notifier)({
      desktop: true,
      urgency_threshold: 'normal',
      save: true,
    });

    expect(saveConfig.mock.calls[0]?.[0].settings.hooks.alerts).toEqual({
      desktop: true,
      sound: false,
      urgency_threshold: 'normal',
      webhook_url: '',
      webhook_events: ['urgent', 'high'],
      allow_private_webhooks: true,
    });
  });

  it('should keep the hooks config alerts equal to the notifier config after a change', async () => {
    const hooksConfig = hooksConfigFor(notifier);

    await captureConfigureAlerts(notifier, hooksConfig)({ desktop: true, save: false });

    expect(hooksConfig.alerts).toEqual(notifier.getConfig());
  });

  it('should turn desktop and sound off when they are given as false', async () => {
    const loud = new NotifierService({ ...base, desktop: true, sound: true });
    try {
      await captureConfigureAlerts(loud)({ desktop: false, sound: false, save: false });

      expect({ desktop: loud.getConfig().desktop, sound: loud.getConfig().sound }).toEqual({
        desktop: false,
        sound: false,
      });
    } finally {
      loud.stop();
    }
  });

  it('should apply an empty webhook_events list', async () => {
    await captureConfigureAlerts(notifier)({ webhook_events: [], save: false });

    expect(notifier.getConfig().webhookEvents).toEqual([]);
  });

  it('should show desktop and sound separately when no field is given', async () => {
    const desktopOnly = new NotifierService({ ...base, desktop: true });
    try {
      const result = await captureConfigureAlerts(desktopOnly)({ save: false });

      expect(result.content[0]?.text.split('\n').slice(1, 3)).toEqual([
        '  Desktop:   ✅',
        '  Sound:     ❌',
      ]);
    } finally {
      desktopOnly.stop();
    }
  });

  it('should list every webhook event comma separated in the confirmation', async () => {
    const result = await captureConfigureAlerts(notifier)({
      webhook_events: ['urgent', 'normal'],
      save: false,
    });

    expect(result.content[0]?.text.split('\n')).toContain('   Events:    urgent, normal');
  });

  it('should tell the user the save failed and the change is session-only', async () => {
    loadRawConfig.mockRejectedValue(new Error('No config file found at: config.toml'));

    const result = await captureConfigureAlerts(notifier)({ sound: true, save: true });

    expect(result.content[0]?.text.split('\n').slice(-2)).toEqual([
      '⚠️ Could not save to config file: No config file found at: config.toml',
      '   Changes are active for this session only.',
    ]);
  });
});
