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

describe('desktop notification commands', () => {
  it.each(['darwin', 'win32'] as const)(
    'keeps notification text out of the %s command script',
    (platform) => {
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
    },
  );

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

  it.each(['darwin', 'linux', 'win32'] as const)(
    'removes every NUL and cuts %s notification text to 200 characters',
    (platform) => {
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
    },
  );

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
