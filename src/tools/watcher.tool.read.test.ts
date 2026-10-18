import type HooksService from '../services/hooks.service.js';
import type { PlatformDiagnostics } from '../services/notifier.service.js';
import NotifierService from '../services/notifier.service.js';
import { listPresets } from '../services/presets.js';
import type WatcherService from '../services/watcher.service.js';
import type { WatcherStatus } from '../services/watcher.service.js';
import type { Handler } from '../test-support/watcher-tool-harness.js';
import { hooksConfigFor } from '../test-support/watcher-tool-harness.js';
import type { HooksConfig } from '../types/index.js';
import { registerWatcherReadTools, registerWatcherWriteTools } from './watcher.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

const alerts = {
  desktop: true,
  sound: false,
  urgencyThreshold: 'high' as const,
  webhookUrl: '',
  webhookEvents: ['urgent' as const, 'high' as const],
};

/** What NotifierService.checkPlatformSupport reports on a Linux box without notify-send. */
const NO_NOTIFY_SEND: PlatformDiagnostics = {
  platform: 'linux',
  supported: false,
  desktopTool: { name: 'notify-send', available: false },
  soundTool: { name: 'paplay', available: true },
  issues: ['notify-send not found'],
  setupInstructions: ['Install libnotify-bin', 'Log out and back in'],
};

describe('watcher read tools', () => {
  let notifier: NotifierService;

  beforeEach(() => {
    notifier = new NotifierService(alerts);
    // The real probe runs `which` on the host; every reply here must not depend on it.
    vi.spyOn(NotifierService, 'checkPlatformSupport').mockResolvedValue(NO_NOTIFY_SEND);
  });

  afterEach(() => {
    notifier.stop();
    vi.restoreAllMocks();
  });

  function tools(
    opts: { status?: WatcherStatus[]; config?: Partial<HooksConfig> } = {},
  ): Record<string, Handler> {
    const handlers: Record<string, Handler> = {};
    const server = {
      registerTool: (name: string, _config: unknown, fn: Handler) => {
        handlers[name] = fn;
      },
    };
    const hooks = {
      getHooksConfig: () => ({ ...hooksConfigFor(notifier), ...opts.config }),
      getNotifier: () => notifier,
    } as unknown as HooksService;
    const watcher = { getStatus: () => opts.status ?? [] } as unknown as WatcherService;
    registerWatcherReadTools(server as never, watcher, hooks);
    registerWatcherWriteTools(server as never, hooks);
    return handlers;
  }

  async function reply(name: string, opts: Parameters<typeof tools>[0] = {}, args = {}) {
    return (await tools(opts)[name]?.(args))?.content[0]?.text;
  }

  it('get_watcher_status should say how to enable the watcher when it is not active', async () => {
    await expect(reply('get_watcher_status')).resolves.toBe(
      'Watcher is not active. Enable it in config: [settings.watcher] enabled = true',
    );
  });

  it('get_watcher_status should show each connection with its state and last UID', async () => {
    const status = [
      { account: 'personal', folder: 'INBOX', connected: true, lastSeenUid: 42 },
      { account: 'work', folder: 'Projects', connected: false, lastSeenUid: 7 },
    ];
    await expect(reply('get_watcher_status', { status })).resolves.toBe(
      [
        '\u{1F4E1} Watcher Status (2 connection(s)):',
        '• personal/INBOX: \u{1F7E2} connected (last UID: 42)',
        '• work/Projects: \u{1F534} disconnected (last UID: 7)',
      ].join('\n'),
    );
  });

  it('list_presets should list every preset with its labels and mark only the active one', async () => {
    const text = (await reply('list_presets', { config: { preset: 'priority-focus' } })) ?? '';
    const blocks = text.split('\n\n').filter((block) => block.startsWith('• '));
    expect({
      blocks,
      footer: text.split('\n\n').at(-1),
    }).toEqual({
      blocks: listPresets().map((p) => {
        const active = p.id === 'priority-focus' ? ' ✅ (active)' : '';
        const labels =
          p.suggestedLabels.length > 0 ? `\n     Labels: ${p.suggestedLabels.join(', ')}` : '';
        return `• ${p.name} [${p.id}]${active}\n     ${p.description}${labels}`;
      }),
      footer:
        'To change preset, set `preset = "priority-focus"` in [settings.hooks] of your config.toml.',
    });
  });

  it('get_hooks_config should list the settings, instructions, rules, alerts and webhook', async () => {
    const config: Partial<HooksConfig> = {
      onNewEmail: 'triage',
      autoLabel: true,
      customInstructions: 'Flag the board.\nIgnore newsletters.',
      rules: [
        {
          name: 'board',
          match: { from: '*@board.example.com', to: 'me@example.com', subject: 'Board*' },
          actions: { labels: ['Board', 'Q4'], flag: true, markRead: true, alert: true },
        },
      ],
      alerts: {
        ...alerts,
        webhookUrl: 'https://hooks.example.com/mail',
      },
    };
    await expect(reply('get_hooks_config', { config })).resolves.toBe(
      [
        '⚙️  Hooks Configuration:',
        '   Mode:     triage',
        '   Preset:   priority-focus',
        '   Labels:   auto-apply',
        '   Flags:    disabled',
        '   Batch:    5s delay',
        '\n\u{1F4DD} Custom Instructions:\n   Flag the board.\n   Ignore newsletters.',
        '\n\u{1F4CB} Static Rules (1):',
        '   • "board": from=*@board.example.com & to=me@example.com & subject=Board* → ' +
          'labels=[Board, Q4], flag, mark_read, \u{1F514} alert',
        '\n\u{1F514} Alerts:',
        '   Desktop:   ✅ enabled',
        '   Sound:     ❌ disabled',
        '   Threshold: high',
        '   Webhook:   https://hooks.example.com/mail',
        '   Events:    urgent, high',
      ].join('\n'),
    );
  });

  it('get_hooks_config should say when no rule and no webhook are configured', async () => {
    const text = (await reply('get_hooks_config')) ?? '';
    expect(text.split('\n').filter((line) => /Static Rules|Webhook/.test(line))).toEqual([
      '\u{1F4CB} Static Rules: none configured',
      '   Webhook:   not configured',
    ]);
  });

  it('check_notification_setup should report the tools, issues, instructions and config', async () => {
    await expect(reply('check_notification_setup')).resolves.toBe(
      [
        '\u{1F50D} Notification Setup Diagnostics',
        '',
        'Platform:    linux',
        'Desktop:     notify-send — ❌ not found',
        'Sound:       paplay — ✅ available',
        'Supported:   ❌ no',
        '',
        '⚠️  Issues:',
        '   • notify-send not found',
        '',
        '\u{1F4CB} Setup Instructions:',
        '   Install libnotify-bin',
        '   Log out and back in',
        '',
        '⚙️  Current Config:',
        '   Desktop:   ✅ enabled',
        '   Sound:     ❌ disabled',
        '   Threshold: high',
        '   Webhook:   not configured',
      ].join('\n'),
    );
  });

  const TIP =
    '\u{1F4A1} Tip: Desktop notifications are supported but disabled.\n' +
    '   Use configure_alerts to enable them, or set desktop = true in config.toml.';

  it.each([
    [false, true, [TIP]],
    [false, false, []],
    [true, true, []],
  ])(
    'check_notification_setup with desktop %s and support %s should show the enable tip %j',
    async (desktop, supported, tips) => {
      vi.mocked(NotifierService.checkPlatformSupport).mockResolvedValue({
        ...NO_NOTIFY_SEND,
        supported,
      });
      notifier.updateConfig({ desktop });
      const text = (await reply('check_notification_setup')) ?? '';
      expect(text.split('\n\n').filter((block) => block.includes('Tip:'))).toEqual(tips);
    },
  );

  it('test_notification should report a failure as an error with the troubleshooting steps', async () => {
    vi.spyOn(notifier, 'sendTestNotification').mockResolvedValue({
      success: false,
      message: 'notify-send not found',
    });
    const result = await tools().test_notification?.({ sound: false });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: '❌ notify-send not found\n\n\u{1F527} Troubleshooting:\n   Install libnotify-bin\n   Log out and back in',
        },
      ],
    });
  });

  it('test_notification should report a sent notification without troubleshooting', async () => {
    vi.spyOn(notifier, 'sendTestNotification').mockImplementation(async (sound = false) => ({
      success: true,
      message: `Test notification sent (sound: ${sound})`,
    }));
    const result = await tools().test_notification?.({ sound: true });
    expect(result).toEqual({
      content: [{ type: 'text', text: '✅ Test notification sent (sound: true)' }],
    });
  });
});
