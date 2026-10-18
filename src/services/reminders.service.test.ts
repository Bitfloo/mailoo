const { osascriptImpl } = vi.hoisted(() => ({
  osascriptImpl: vi.fn(
    async (
      _file: string,
      _args: string[],
      _options: { timeout?: number },
    ): Promise<{ stdout: string; stderr: string }> => ({ stdout: '[]', stderr: '' }),
  ),
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => undefined, {
    [Symbol.for('nodejs.util.promisify.custom')]: osascriptImpl,
  }),
}));

import { delimitUntrusted } from '../safety/untrusted-content.js';
import { literalAfter } from '../test-support/applescript.js';
import onDarwin from '../test-support/platform.js';
import RemindersService from './reminders.service.js';

async function withReminders<T>(fn: (svc: RemindersService) => Promise<T>): Promise<T> {
  return onDarwin(async () => fn(new RemindersService()));
}

beforeEach(() => {
  osascriptImpl.mockReset();
  osascriptImpl.mockResolvedValue({ stdout: '[]', stderr: '' });
});

describe('RemindersService osascript results', () => {
  it('should reject listReminders when osascript fails instead of reporting no reminders', async () => {
    osascriptImpl.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: osascript'), {
        killed: true,
        signal: 'SIGTERM',
        code: null,
        stderr: '',
      }),
    );
    await expect(withReminders(async (svc) => svc.listReminders())).rejects.toThrow(
      'osascript timed out after 15 s',
    );
  });

  it('should return a reminder whose title holds a tab', async () => {
    // jsonString escapes backslash and quote only; AppleScript emits the tab raw.
    osascriptImpl.mockResolvedValueOnce({
      stdout:
        '[{"id":"x-apple-reminder://R1","title":"Pay \\"Acme\\"\tinvoice","dueDate":"","completed":false,"priority":"high","list":"Work"}]\n',
      stderr: '',
    });
    const reminders = await withReminders(async (svc) => svc.listReminders());
    expect(reminders.map((r) => r.title)).toEqual(['Pay "Acme"\tinvoice']);
  });

  it('should report stderr, not the script with the reminder title, when adding fails', async () => {
    osascriptImpl.mockRejectedValueOnce(
      Object.assign(
        new Error('Command failed: osascript -e set dialogText to "Renew passport for Jane"'),
        {
          killed: false,
          code: 1,
          stderr: '0:118: execution error: Reminders got an error: AppleEvent timed out. (-1712)\n',
        },
      ),
    );
    const result = await withReminders(async (svc) =>
      svc.addReminder({ title: 'Renew passport for Jane' }, { confirm: false }),
    );
    expect(result).toEqual({
      status: 'no_display',
      message:
        'Could not add reminder: osascript failed: 0:118: execution error: Reminders got an error: AppleEvent timed out. (-1712)',
    });
  });

  it('should return the status, reminder id and list name the add script reports', async () => {
    osascriptImpl.mockResolvedValueOnce({
      stdout:
        '{"status":"added","reminderId":"x-apple-reminder://R2","listName":"Home \\"Q4\\""}\n',
      stderr: '',
    });
    const result = await withReminders(async (svc) =>
      svc.addReminder({ title: 'Call the bank', listName: 'Work' }, { confirm: false }),
    );
    expect(result).toEqual({
      status: 'added',
      reminderId: 'x-apple-reminder://R2',
      listName: 'Home "Q4"',
      message: `✅ Reminder added: "${delimitUntrusted('Call the bank')}" → Home "Q4".`,
    });
  });

  it('should report a timed-out dialog as timed_out with a try-again message', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"timed_out"}\n', stderr: '' });
    const result = await withReminders(async (svc) => svc.addReminder({ title: 'Call the bank' }));
    expect(result).toEqual({
      status: 'timed_out',
      message: '⏱️ Dialog timed out — reminder was not added. Try again.',
    });
  });

  it.each([
    ['cancelled', '\u{1F6AB} Cancelled \u2014 reminder was not added.'],
    [
      'no_display',
      '\u26A0\uFE0F Cannot add reminder: run check_calendar_permissions to verify access.',
    ],
  ])('should word a %s reply from the add script', async (status, message) => {
    osascriptImpl.mockResolvedValueOnce({ stdout: `{"status":"${status}"}\n`, stderr: '' });
    const result = await withReminders(async (svc) => svc.addReminder({ title: 'Call the bank' }));
    expect(result).toEqual({ status, message });
  });

  it('should name the Reminders list when the add script reports no list', async () => {
    osascriptImpl.mockResolvedValueOnce({
      stdout: '{"status":"added","reminderId":"x-apple-reminder://R3"}\n',
      stderr: '',
    });
    const result = await withReminders(async (svc) =>
      svc.addReminder({ title: 'Call the bank' }, { confirm: false }),
    );
    expect(result.message).toBe(
      `\u2705 Reminder added: "${delimitUntrusted('Call the bank')}" \u2192 Reminders.`,
    );
  });

  it('should pass every listed reminder field and the added ids through jsonString', async () => {
    await withReminders(async (svc) => svc.listReminders());
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"added"}', stderr: '' });
    await withReminders(async (svc) =>
      svc.addReminder({ title: 'Call the bank' }, { confirm: false }),
    );
    const listScript = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    const addScript = osascriptImpl.mock.calls[1]?.[1][1] ?? '';
    expect({
      list: ['rId', 'rTitle', 'rDue', 'listName'].filter(
        (f) => !listScript.includes(`my jsonString(${f})`),
      ),
      add: ['remId', 'finalList'].filter((f) => !addScript.includes(`my jsonString(${f})`)),
    }).toEqual({ list: [], add: [] });
  });
});

describe('RemindersService checkPermissions', () => {
  it('should report Reminders access granted when Reminders returns its list count', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '3\n', stderr: '' });
    const result = await withReminders(async (svc) => svc.checkPermissions());
    expect(result).toEqual({ granted: true, platform: 'darwin', instructions: [] });
  });

  it('should report Reminders access granted when Reminders has no lists', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '0\n', stderr: '' });
    const result = await withReminders(async (svc) => svc.checkPermissions());
    expect(result.granted).toBe(true);
  });

  it('should report no Reminders access when osascript rejects', async () => {
    osascriptImpl.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: osascript'), {
        killed: false,
        code: 1,
        stderr:
          '0:46: execution error: Not authorized to send Apple events to Reminders. (-1743)\n',
      }),
    );
    const result = await withReminders(async (svc) => svc.checkPermissions());
    expect(result).toEqual({
      granted: false,
      platform: 'darwin',
      instructions: [
        'Reminders access was denied or unavailable.',
        '1. Open System Settings \u2192 Privacy & Security \u2192 Reminders',
        '2. Enable access for Terminal (or your terminal emulator)',
        '3. Quit and restart the terminal, then try again.',
      ],
    });
  });
});

describe('listReminders script', () => {
  it('should keep a quoted title and list filter intact in the list_reminders script', async () => {
    const opts = { title: 'Pay "Acme" \\ invoice', listName: 'Home "Q4"' };
    await withReminders(async (svc) => svc.listReminders(opts));
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect({
      title: literalAfter(script, 'set titleFilter to '),
      list: literalAfter(script, 'set listFilter to '),
    }).toEqual({ title: opts.title, list: opts.listName });
  });
});

describe('listReminders options', () => {
  it('should list 20 incomplete reminders by default', async () => {
    await withReminders(async (svc) => svc.listReminders());
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect(
      script.split('\n').filter((line) => /^set (maxResults|includeCompleted) to /.test(line)),
    ).toEqual(['set maxResults to 20', 'set includeCompleted to false']);
  });

  it('should pass limit and includeCompleted into the list script', async () => {
    await withReminders(async (svc) => svc.listReminders({ limit: 5, includeCompleted: true }));
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect(
      script.split('\n').filter((line) => /^set (maxResults|includeCompleted) to /.test(line)),
    ).toEqual(['set maxResults to 5', 'set includeCompleted to true']);
  });

  it('should map the priorities 1, 5 and 9 and the completion flag in the list script', async () => {
    await withReminders(async (svc) => svc.listReminders());
    const lines = (osascriptImpl.mock.calls[0]?.[1][1] ?? '')
      .split('\n')
      .map((line) => line.trim());
    expect(lines.filter((line) => /^if (rPriority is|isComp then)/.test(line))).toEqual([
      'if rPriority is 1 then set pLabel to "high"',
      'if rPriority is 5 then set pLabel to "medium"',
      'if rPriority is 9 then set pLabel to "low"',
      'if isComp then set compStr to "true"',
    ]);
  });
});

describe('RemindersService off macOS', () => {
  it('should refuse add, list and permission checks without running osascript', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      const svc = new RemindersService();
      expect({
        add: await svc.addReminder({ title: 'Call the bank' }),
        list: await svc.listReminders(),
        permissions: await svc.checkPermissions(),
        osascriptRuns: osascriptImpl.mock.calls.length,
      }).toEqual({
        add: { status: 'no_display', message: 'Reminders.app is only available on macOS.' },
        list: [],
        permissions: {
          granted: false,
          platform: 'linux',
          instructions: ['Reminders.app is only available on macOS.'],
        },
        osascriptRuns: 0,
      });
    } finally {
      platform.mockRestore();
    }
  });
});
