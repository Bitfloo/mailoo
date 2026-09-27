import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

import { resolveWebhookUrl } from '../safety/validation.js';
import NotifierService, { desktopNotificationCommands, postWebhook } from './notifier.service.js';

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

/** Localhost delivery is immediate. Past this, the POST did not use the checked address. */
const WEBHOOK_DELIVERY_BOUND_MS = 500;

/** A followed redirect would open a second localhost request inside this window. */
const REDIRECT_FOLLOW_WINDOW_MS = 50;

async function listenOnLoopback(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('expected a loopback port'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function restorePublicLookup(): void {
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockImplementation(async () => [{ address: '192.0.2.10', family: 4 }] as never);
}

describe('NotifierService webhook payload', () => {
  it('includes uid, messageId, folder, and hasAttachments', async () => {
    let raw = '';
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        raw = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200);
        res.end();
      });
    });
    const port = await listenOnLoopback(server);

    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'low',
        webhookUrl: `http://127.0.0.1:${port}/alert`,
        webhookEvents: ['normal'],
        allowPrivateWebhooks: true,
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

      await vi.waitFor(
        () => {
          expect(raw.length).toBeGreaterThan(0);
        },
        { timeout: WEBHOOK_DELIVERY_BOUND_MS },
      );
      const body = JSON.parse(raw) as Record<string, unknown>;
      expect(body.uid).toBe('42');
      expect(body.messageId).toBe('<mid@example.com>');
      expect(body.folder).toBe('INBOX');
      expect(body.hasAttachments).toBe(true);
      expect(body.account).toBe('work');
    } finally {
      await closeServer(server);
    }
  });

  it('does not follow a webhook redirect', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(302, { Location: '/other' });
      res.end();
    });
    const port = await listenOnLoopback(server);

    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'low',
        webhookUrl: `http://127.0.0.1:${port}/hook`,
        webhookEvents: ['normal'],
        allowPrivateWebhooks: true,
      });
      await notifier.alert({
        account: 'work',
        sender: { address: 'ada@example.com' },
        subject: 'Hello',
        priority: 'normal',
      });
      await vi.waitFor(
        () => {
          expect(hits).toEqual(['/hook']);
        },
        { timeout: WEBHOOK_DELIVERY_BOUND_MS },
      );
      await new Promise((resolve) => {
        setTimeout(resolve, REDIRECT_FOLLOW_WINDOW_MS);
      });
      expect(hits).toEqual(['/hook']);
    } finally {
      await closeServer(server);
    }
  });

  it('does not post to a metadata address', async () => {
    const request = vi.spyOn(http, 'request');
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
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });

  it('posts to a loopback webhook when private targets are allowed', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200);
      res.end();
    });
    const port = await listenOnLoopback(server);

    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'low',
        webhookUrl: `http://127.0.0.1:${port}/hook`,
        webhookEvents: ['normal'],
        allowPrivateWebhooks: true,
      });

      await notifier.alert({
        account: 'work',
        sender: { address: 'ada@example.com' },
        subject: 'Hello',
        priority: 'normal',
      });

      await vi.waitFor(
        () => {
          expect(hits).toEqual(['/hook']);
        },
        { timeout: WEBHOOK_DELIVERY_BOUND_MS },
      );
    } finally {
      await closeServer(server);
    }
  });

  it('does not post when the webhook host resolves to a private address', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }] as never);
    const request = vi.spyOn(https, 'request');

    try {
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
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      restorePublicLookup();
    }
  });

  it('posts to the address the connect lookup returned', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    let raw = '';
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        raw = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200);
        res.end();
      });
    });
    const port = await listenOnLoopback(server);

    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'low',
        webhookUrl: `http://hooks.example.com:${port}/hook`,
        webhookEvents: ['normal'],
        allowPrivateWebhooks: true,
      });
      await notifier.alert({
        account: 'work',
        sender: { address: 'ada@example.com' },
        subject: 'Hello',
        priority: 'normal',
      });
      await vi.waitFor(
        () => {
          expect(raw).toContain('"account":"work"');
        },
        { timeout: WEBHOOK_DELIVERY_BOUND_MS },
      );
    } finally {
      await closeServer(server);
      restorePublicLookup();
    }
  });

  it('refuses the connection when a later lookup returns a loopback address', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    const url = `http://hooks.example.com:${address.port}/hook`;
    const answers = [['192.0.2.10'], ['127.0.0.1']];
    const resolveName = async (): Promise<readonly string[]> => answers.shift() ?? ['127.0.0.1'];

    try {
      await expect(resolveWebhookUrl(url, { lookup: resolveName })).resolves.toBeUndefined();
      // Bounds a connect that ignored the checked address. The refusal itself is immediate.
      await expect(
        postWebhook(url, '{}', { lookup: resolveName, signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow(/loopback or private/);
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('refuses the connection when any looked-up address is loopback', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200);
      res.end();
    });
    const port = await listenOnLoopback(server);
    const url = `http://hooks.example.com:${port}/hook`;
    const answers = [['192.0.2.10'], ['192.0.2.10', '127.0.0.1']];
    const resolveName = async (): Promise<readonly string[]> => answers.shift() ?? ['127.0.0.1'];

    try {
      await expect(resolveWebhookUrl(url, { lookup: resolveName })).resolves.toBeUndefined();
      await expect(
        postWebhook(url, '{}', { lookup: resolveName, signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow(/loopback or private/);
      expect(hits).toEqual([]);
    } finally {
      await closeServer(server);
    }
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
    // This quote is what a linux-only escape would rewrite; argv must keep it.
    const body = 'zażółć ’quote’';
    const commands = desktopNotificationCommands('linux', 'Title ZZ', body, false);
    expect(commands).toEqual([
      { bin: 'notify-send', args: ['-u', 'normal', '--', 'Title ZZ', body] },
    ]);
  });

  it('passes a linux title that starts with a dash after the option terminator', () => {
    const [command] = desktopNotificationCommands('linux', '-u', 'Body ZZ', false);
    expect(command.args).toEqual(['-u', 'normal', '--', '-u', 'Body ZZ']);
  });

  it('does not build a desktop command for an unsupported platform', () => {
    expect(desktopNotificationCommands('freebsd', 'Title ZZ', 'Body ZZ', false)).toEqual([]);
  });

  it('marks a sounding linux notification critical and plays the message sound', () => {
    expect(desktopNotificationCommands('linux', 'Title ZZ', 'Body ZZ', true)).toEqual([
      { bin: 'notify-send', args: ['-u', 'critical', '--', 'Title ZZ', 'Body ZZ'] },
      {
        bin: 'paplay',
        args: ['/usr/share/sounds/freedesktop/stereo/message-new-instant.oga'],
      },
    ]);
  });

  it('passes windows notification text in the environment of a fixed script', () => {
    const commands = desktopNotificationCommands('win32', 'Title ZZ', 'Body ZZ', false);
    expect(commands).toEqual([
      {
        bin: 'powershell',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')",
            '$n = New-Object System.Windows.Forms.NotifyIcon',
            '$n.Icon = [System.Drawing.SystemIcons]::Information',
            '$n.Visible = $true',
            "$n.ShowBalloonTip(5000, $env:MAILOO_NOTIFY_TITLE, $env:MAILOO_NOTIFY_BODY, 'Info')",
          ].join('; '),
        ],
        env: {
          MAILOO_NOTIFY_TITLE: 'Title ZZ',
          MAILOO_NOTIFY_BODY: 'Body ZZ',
        },
      },
    ]);
  });

  it.each([
    'darwin',
    'linux',
    'win32',
  ] as const)('removes every NUL and cuts %s notification text to 200 characters', (platform) => {
    // Both NULs are removed before the cut, so 200 letters remain and the next letter is gone.
    const text = `\0${'a'.repeat(99)}\0${'a'.repeat(101)}Z`;
    const bounded = 'a'.repeat(200);
    const [command] = desktopNotificationCommands(platform, text, text, false);
    if (platform === 'linux') {
      expect(command.args).toEqual(['-u', 'normal', '--', bounded, bounded]);
    } else if (platform === 'darwin') {
      expect(command).toEqual({
        bin: 'osascript',
        args: [
          '-e',
          'on run argv',
          '-e',
          'display notification (item 2 of argv) with title (item 1 of argv)',
          '-e',
          'end run',
          '--',
          bounded,
          bounded,
        ],
      });
    } else {
      expect(command).toEqual({
        bin: 'powershell',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          [
            "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')",
            '$n = New-Object System.Windows.Forms.NotifyIcon',
            '$n.Icon = [System.Drawing.SystemIcons]::Information',
            '$n.Visible = $true',
            "$n.ShowBalloonTip(5000, $env:MAILOO_NOTIFY_TITLE, $env:MAILOO_NOTIFY_BODY, 'Info')",
          ].join('; '),
        ],
        env: {
          MAILOO_NOTIFY_TITLE: bounded,
          MAILOO_NOTIFY_BODY: bounded,
        },
      });
    }
  });

  it('does not put over-cap macOS text in the environment when sound is on', () => {
    const text = `\0${'a'.repeat(99)}\0${'a'.repeat(101)}Z`;
    const bounded = 'a'.repeat(200);
    const [command] = desktopNotificationCommands('darwin', text, text, true);
    expect(command).toEqual({
      bin: 'osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
        '-e',
        'end run',
        '--',
        bounded,
        bounded,
      ],
    });
  });

  it('adds the Glass sound to the macOS notification when sound is on', () => {
    const [command] = desktopNotificationCommands('darwin', 'Title ZZ', 'Body ZZ', true);
    expect(command).toEqual({
      bin: 'osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
        '-e',
        'end run',
        '--',
        'Title ZZ',
        'Body ZZ',
      ],
    });
  });

  it('passes a macOS title of -e as data after the option terminator', () => {
    const [command] = desktopNotificationCommands('darwin', '-e', 'Body ZZ', false);
    expect(command.args).toEqual([
      '-e',
      'on run argv',
      '-e',
      'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e',
      'end run',
      '--',
      '-e',
      'Body ZZ',
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
      const call = execFileMock.mock.calls.find((entry) => entry[0] === 'osascript');
      expect(call?.[1]).toEqual([
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        '--',
        '📧 Mailoo — Urgent',
        `From: ada@example.com\n${subject}`,
      ]);
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
