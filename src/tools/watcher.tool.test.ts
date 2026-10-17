import type HooksService from '../services/hooks.service.js';
import NotifierService from '../services/notifier.service.js';
import { readAuditEntries } from '../test-support/audit-home.js';
import { registerWatcherWriteTools } from './watcher.tool.js';

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

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: string; text: string }[];
}>;

function captureConfigureAlerts(notifier: NotifierService): Handler {
  let handler: Handler | undefined;
  const hooksConfig = {
    onNewEmail: 'notify' as const,
    preset: 'priority-focus' as const,
    autoLabel: false,
    autoFlag: false,
    batchDelay: 5,
    rules: [],
    alerts: notifier.getConfig(),
  };
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => {
      if (name === 'configure_alerts') handler = fn;
    },
  };
  registerWatcherWriteTools(
    server as never,
    {
      getHooksConfig: () => hooksConfig,
      getNotifier: () => notifier,
    } as unknown as HooksService,
  );
  if (!handler) throw new Error('configure_alerts handler was not registered');
  return handler;
}

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

describe('configure_alerts audit log', () => {
  const base = {
    desktop: false,
    sound: false,
    urgencyThreshold: 'high' as const,
    webhookUrl: '',
    webhookEvents: ['urgent' as const, 'high' as const],
  };
  /** Chat webhooks carry their credential in the path. */
  const SECRET_HOOK = 'https://hooks.example.com/services/T0001/B0001/s3cr3t-hook-token';

  let notifier: NotifierService;

  beforeEach(() => {
    loadRawConfig.mockReset();
    saveConfig.mockReset();
    notifier = new NotifierService(base);
  });

  afterEach(() => {
    notifier.stop();
  });

  /** The SDK hands the handler parsed args, so `save` carries its schema default. */
  async function lastEntryAfter(args: Record<string, unknown>) {
    await captureConfigureAlerts(notifier)({ save: false, ...args });
    return (await readAuditEntries(auditHome)).at(-1);
  }

  it('should record a change under system with only the webhook origin', async () => {
    const entry = await lastEntryAfter({ desktop: true, webhook_url: SECRET_HOOK });

    expect(entry).toEqual({
      ts: expect.any(String),
      tool: 'configure_alerts',
      account: 'system',
      params: { desktop: true, webhookUrl: 'https://hooks.example.com', save: false },
      result: 'ok',
    });
  });

  it('should record a refused webhook URL as an error without its path', async () => {
    const entry = await lastEntryAfter({ webhook_url: 'hooks.example.com/s3cr3t-hook-token' });

    expect({
      result: entry?.result,
      leaked: JSON.stringify(entry ?? null).includes('s3cr3t'),
    }).toEqual({
      result: 'error',
      leaked: false,
    });
  });

  it('should record a non-http webhook URL as a placeholder, not the URL', async () => {
    // new URL('mailto:…').origin is the string 'null'; the whole URL must not reach the log.
    const entry = await lastEntryAfter({ webhook_url: 'mailto:ops-s3cr3t@example.test' });

    expect(entry?.params).toEqual({ webhookUrl: '[not an http(s) URL]', save: false });
  });

  it('should record a change whose save failed as an error with the reason', async () => {
    loadRawConfig.mockRejectedValue(new Error('No config file found at: config.toml'));

    const entry = await lastEntryAfter({ sound: true, save: true });

    expect(entry).toMatchObject({
      tool: 'configure_alerts',
      params: { sound: true, save: true },
      result: 'error',
      error: 'Not saved: No config file found at: config.toml',
    });
  });

  it('should write no entry when the call changes nothing', async () => {
    const before = (await readAuditEntries(auditHome)).length;

    await captureConfigureAlerts(notifier)({ save: false });

    expect(await readAuditEntries(auditHome)).toHaveLength(before);
  });
});
