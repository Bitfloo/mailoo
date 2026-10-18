import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { __resetForTesting, bindServer, markInitialized } from '../logging.js';
import type { AlertPayload, UrgencyLevel } from './notifier.service.js';
import NotifierService from './notifier.service.js';

const { execFileMock } = vi.hoisted(() => {
  const mock = vi.fn(
    (_file: string, _args: unknown, options: unknown, callback?: (err: Error | null) => void) => {
      const cb = typeof options === 'function' ? options : callback;
      if (typeof cb === 'function') cb(null);
    },
  );
  return { execFileMock: mock };
});

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '192.0.2.10', family: 4 }]),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

describe('NotifierService runtime alert updates', () => {
  const base = {
    desktop: false,
    sound: false,
    urgencyThreshold: 'high' as const,
    webhookUrl: '',
    webhookEvents: ['urgent' as const, 'high' as const],
    allowPrivateWebhooks: false,
  };

  it('should not keep the process alive with the desktop rate reset interval', () => {
    const notifier = new NotifierService(base);
    // Private on purpose: hasRef() is the only observable of an unref'd interval in-process.
    const timer = (notifier as unknown as { desktopResetTimer: NodeJS.Timeout }).desktopResetTimer;
    const referenced = timer.hasRef();
    notifier.stop();

    expect(referenced).toBe(false);
  });

  it('does not store a webhook URL that contains a line break', () => {
    const notifier = new NotifierService(base);
    expect(() => notifier.updateConfig({ webhookUrl: 'http://hooks.example.com/hook\n' })).toThrow(
      /control characters/,
    );
    expect(notifier.getConfig().webhookUrl).toBe('');
    notifier.stop();
  });

  it('does not store a webhook URL that contains credentials', () => {
    const notifier = new NotifierService(base);
    expect(() =>
      notifier.updateConfig({ webhookUrl: 'https://user:secret@hooks.example.com/hook' }),
    ).toThrow(/credentials/);
    expect(notifier.getConfig().webhookUrl).toBe('');
    notifier.stop();
  });

  it('does not store an unknown urgency threshold', () => {
    const notifier = new NotifierService(base);
    expect(() => notifier.updateConfig({ urgencyThreshold: 'critical' as 'high' })).toThrow(
      /threshold/,
    );
    expect(notifier.getConfig().urgencyThreshold).toBe('high');
    notifier.stop();
  });

  it('does not let a runtime update opt a webhook into a loopback address', () => {
    const notifier = new NotifierService(base);
    expect(() =>
      notifier.updateConfig({
        webhookUrl: 'http://127.0.0.1/hook',
        allowPrivateWebhooks: true,
      }),
    ).toThrow(/loopback or private/);
    expect(notifier.getConfig().webhookUrl).toBe('');
    expect(notifier.getConfig().allowPrivateWebhooks).toBe(false);
    notifier.stop();
  });
});

describe('NotifierService alert log', () => {
  const quiet = {
    desktop: false,
    sound: false,
    urgencyThreshold: 'high' as const,
    webhookUrl: '',
    webhookEvents: ['urgent' as const, 'high' as const],
  };

  /** Same fields HooksService.notifyBatch builds from a fetched envelope. */
  function payload(priority: UrgencyLevel): AlertPayload {
    return {
      account: 'personal',
      sender: { name: 'Alice Example', address: 'alice@example.com' },
      subject: 'Quarterly numbers for review',
      uid: '4711',
      messageId: '<q3-4711@example.com>',
      folder: 'INBOX',
      hasAttachments: false,
      priority,
      labels: ['Finance'],
      ruleName: 'finance-team',
    };
  }

  let sent: { level: string; data: unknown }[];

  beforeEach(() => {
    sent = [];
    // The real logging bridge with a connected fake server: assert what the client receives.
    bindServer({
      isConnected: () => true,
      sendLoggingMessage: async (msg: { level: string; data: unknown }) => {
        sent.push(msg);
      },
    } as unknown as McpServer);
    markInitialized();
  });

  afterEach(() => {
    __resetForTesting();
  });

  async function alertAt(priority: UrgencyLevel): Promise<void> {
    const notifier = new NotifierService(quiet);
    await notifier.alert(payload(priority));
    notifier.stop();
  }

  it.each(['urgent', 'high', 'normal'] as const)(
    'should send no sender or subject above debug for a %s alert',
    async (priority) => {
      await alertAt(priority);

      const visible = JSON.stringify(sent.filter((m) => m.level !== 'debug'));

      expect(visible).not.toMatch(/Alice|alice@example\.com|Quarterly/);
    },
  );

  it.each([
    ['urgent', 'alert'],
    ['high', 'warning'],
    ['normal', 'info'],
  ] as const)(
    'should report a %s alert at %s with account, folder, uid, labels and rule',
    async (priority, level) => {
      await alertAt(priority);

      expect(sent.find((m) => m.level === level)?.data).toBe(
        `${priority === 'urgent' ? '🚨' : '📧'} [${priority.toUpperCase()}] ` +
          'personal/INBOX uid 4711 [Finance] (rule: finance-team)',
      );
    },
  );

  it('should send the sender and subject of a normal alert at debug only', async () => {
    await alertAt('normal');

    expect(sent.filter((m) => m.level === 'debug').map((m) => m.data)).toEqual([
      '📧 [NORMAL] personal/INBOX uid 4711 from Alice Example: "Quarterly numbers for review"',
    ]);
  });

  it('should name a sender without a display name by address', async () => {
    const notifier = new NotifierService(quiet);
    await notifier.alert({ ...payload('low'), sender: { address: 'billing@example.com' } });
    notifier.stop();

    expect(sent.map((m) => m.data)).toEqual([
      '📧 [LOW] personal/INBOX uid 4711 from billing@example.com: "Quarterly numbers for review" ' +
        '[Finance] (rule: finance-team)',
    ]);
  });

  it('should leave the folder and uid out of the entry when the payload has neither', async () => {
    const notifier = new NotifierService(quiet);
    await notifier.alert({ ...payload('normal'), folder: undefined, uid: undefined });
    notifier.stop();

    expect(sent.find((m) => m.level === 'info')?.data).toBe(
      '📧 [NORMAL] personal [Finance] (rule: finance-team)',
    );
  });

  it('should send a low alert as one debug message with the sender and subject', async () => {
    await alertAt('low');

    expect(sent).toEqual([
      {
        level: 'debug',
        logger: 'notifier',
        data:
          '📧 [LOW] personal/INBOX uid 4711 from Alice Example: "Quarterly numbers for review" ' +
          '[Finance] (rule: finance-team)',
      },
    ]);
  });
});
