import { lookup } from 'node:dns/promises';

import NotifierService, { desktopNotificationCommands } from './notifier.service.js';

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

/** Webhook dispatch continues after alert() returns; flush that turn before asserting. */
async function flushWebhook(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe('NotifierService webhook payload', () => {
  it('includes uid, messageId, folder, and hasAttachments', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new NotifierService({
      desktop: false,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: 'https://hooks.example.com/alert',
      webhookEvents: ['normal'],
    });

    await notifier.alert({
      account: 'work',
      sender: { name: 'Ada', address: 'ada@example.com' },
      subject: 'Hello',
      priority: 'normal',
      uid: '42',
      messageId: '<mid@example.com>',
      folder: 'INBOX',
      hasAttachments: true,
    });

    await flushWebhook();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(body.uid).toBe('42');
    expect(body.messageId).toBe('<mid@example.com>');
    expect(body.folder).toBe('INBOX');
    expect(body.hasAttachments).toBe(true);
    expect(body.account).toBe('work');
    const init = fetchMock.mock.calls[0][1] as { redirect?: string; signal?: AbortSignal };
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    vi.unstubAllGlobals();
  });

  it('does not post to a metadata address', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new NotifierService({
      desktop: false,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: 'http://169.254.169.254/latest/meta-data/',
      webhookEvents: ['normal'],
    });

    await notifier.alert({
      account: 'work',
      sender: { address: 'ada@example.com' },
      subject: 'Hello',
      priority: 'normal',
    });

    await flushWebhook();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('posts to a loopback webhook when private targets are allowed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new NotifierService({
      desktop: false,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: 'http://127.0.0.1/hook',
      webhookEvents: ['normal'],
      allowPrivateWebhooks: true,
    });

    await notifier.alert({
      account: 'work',
      sender: { address: 'ada@example.com' },
      subject: 'Hello',
      priority: 'normal',
    });

    await flushWebhook();
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('does not post when the webhook host resolves to a private address', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as never);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = new NotifierService({
      desktop: false,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: 'https://hooks.example.com/alert',
      webhookEvents: ['normal'],
    });

    await notifier.alert({
      account: 'work',
      sender: { address: 'ada@example.com' },
      subject: 'Hello',
      priority: 'normal',
    });

    await flushWebhook();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('NotifierService runtime alert updates', () => {
  const base = {
    desktop: false,
    sound: false,
    urgencyThreshold: 'high' as const,
    webhookUrl: '',
    webhookEvents: ['urgent' as const, 'high' as const],
    allowPrivateWebhooks: false,
  };

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

describe('desktop notification commands', () => {
  it.each([
    'darwin',
    'win32',
  ] as const)('keeps notification text out of the %s command script', (platform) => {
    const commands = desktopNotificationCommands(platform, 'Title ZZ', 'Body ZZ', true);
    commands.forEach((command) => {
      const script = command.args
        .filter((arg) => arg.includes('display notification') || arg.includes('ShowBalloonTip'))
        .join('\n');
      expect(script).not.toContain('Title ZZ');
      expect(script).not.toContain('Body ZZ');
      const carried = [...command.args, ...Object.values(command.env ?? {})].join('\n');
      if (command.bin === 'paplay') {
        expect(command.args).toEqual([
          '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga',
        ]);
        return;
      }
      expect(carried).toContain('Title ZZ');
      expect(carried).toContain('Body ZZ');
    });
  });

  it('passes linux notification text as arguments after the option terminator', () => {
    const commands = desktopNotificationCommands('linux', 'Title ZZ', 'Body ZZ', false);
    expect(commands).toEqual([
      { bin: 'notify-send', args: ['-u', 'normal', '--', 'Title ZZ', 'Body ZZ'] },
    ]);
  });

  it('passes a non-ASCII subject to osascript argv unchanged on macOS', async () => {
    // This subject is the MacRoman failure (and a quote a script escape would rewrite).
    const subject = 'zażółć ’quote’';
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    execFileMock.mockClear();
    const notifier = new NotifierService({
      desktop: true,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: '',
      webhookEvents: [],
    });
    try {
      await notifier.alert({
        account: 'work',
        sender: { address: 'ada@example.com' },
        subject,
        priority: 'urgent',
      });
      const calls = execFileMock.mock.calls.filter((call) => call[0] === 'osascript');
      expect(calls).toHaveLength(1);
      const args = calls[0][1] as string[];
      const statements = args.filter((_, index) => args[index - 1] === '-e');
      expect(statements.join('\n')).not.toContain(subject);
      expect(args).toContain(`From: ada@example.com\n${subject}`);
    } finally {
      platform.mockRestore();
      notifier.stop();
    }
  });

  it('does not place the message subject inside the desktop command script', async () => {
    execFileMock.mockClear();
    const notifier = new NotifierService({
      desktop: true,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: '',
      webhookEvents: [],
    });
    await notifier.alert({
      account: 'work',
      sender: { address: 'ada@example.com' },
      subject: 'ZZMARKER',
      priority: 'urgent',
    });
    const calls = execFileMock.mock.calls.filter((call) =>
      ['osascript', 'notify-send', 'powershell'].includes(String(call[0])),
    );
    expect(calls.length).toBeGreaterThan(0);
    calls.forEach((call) => {
      const args = call[1] as string[];
      const script = args
        .filter((arg) => arg.includes('display notification') || arg.includes('ShowBalloonTip'))
        .join('\n');
      expect(script).not.toContain('ZZMARKER');
      const options = call[2] as { env?: Record<string, string> } | undefined;
      const carried = [...args, ...Object.values(options?.env ?? {})].join('\n');
      expect(carried).toContain('ZZMARKER');
    });
    notifier.stop();
  });
});
