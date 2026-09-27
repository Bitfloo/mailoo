import type HooksService from '../services/hooks.service.js';
import NotifierService from '../services/notifier.service.js';
import type WatcherService from '../services/watcher.service.js';
import registerWatcherTools from './watcher.tool.js';

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
  registerWatcherTools(
    server as never,
    {} as WatcherService,
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
