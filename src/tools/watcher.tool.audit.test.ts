import NotifierService from '../services/notifier.service.js';
import { readAuditEntries } from '../test-support/audit-home.js';
import { captureConfigureAlerts } from '../test-support/watcher-tool-harness.js';

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

  it("should record an emptied webhook_url as ''", async () => {
    // An empty URL turns the webhook off; it is not an invalid URL.
    const entry = await lastEntryAfter({ webhook_url: '' });

    expect(entry?.params).toEqual({ webhookUrl: '', save: false });
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
