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
import RemindersService from './reminders.service.js';

/** Builds the service while it believes it is on macOS, where osascript is used. */
async function onDarwin<T>(fn: (svc: RemindersService) => Promise<T>): Promise<T> {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  try {
    return await fn(new RemindersService());
  } finally {
    platform.mockRestore();
  }
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
    await expect(onDarwin(async (svc) => svc.listReminders())).rejects.toThrow(
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
    const reminders = await onDarwin(async (svc) => svc.listReminders());
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
    const result = await onDarwin(async (svc) =>
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
    const result = await onDarwin(async (svc) =>
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
    const result = await onDarwin(async (svc) => svc.addReminder({ title: 'Call the bank' }));
    expect(result).toEqual({
      status: 'timed_out',
      message: '⏱️ Dialog timed out — reminder was not added. Try again.',
    });
  });

  it('should pass every listed reminder field and the added ids through jsonString', async () => {
    await onDarwin(async (svc) => svc.listReminders());
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"added"}', stderr: '' });
    await onDarwin(async (svc) => svc.addReminder({ title: 'Call the bank' }, { confirm: false }));
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
    const result = await onDarwin(async (svc) => svc.checkPermissions());
    expect(result).toEqual({ granted: true, platform: 'darwin', instructions: [] });
  });

  it('should report Reminders access granted when Reminders has no lists', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '0\n', stderr: '' });
    const result = await onDarwin(async (svc) => svc.checkPermissions());
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
    const result = await onDarwin(async (svc) => svc.checkPermissions());
    expect({ granted: result.granted, first: result.instructions[0] }).toEqual({
      granted: false,
      first: 'Reminders access was denied or unavailable.',
    });
  });
});

describe('listReminders script', () => {
  it('should keep a quoted title and list filter intact in the list_reminders script', async () => {
    const opts = { title: 'Pay "Acme" \\ invoice', listName: 'Home "Q4"' };
    await onDarwin(async (svc) => svc.listReminders(opts));
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect({
      title: literalAfter(script, 'set titleFilter to '),
      list: literalAfter(script, 'set listFilter to '),
    }).toEqual({ title: opts.title, list: opts.listName });
  });
});

describe('listReminders defaults', () => {
  it('should list 20 incomplete reminders by default', async () => {
    await onDarwin(async (svc) => svc.listReminders());
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect(
      script.split('\n').filter((line) => /^set (maxResults|includeCompleted) to /.test(line)),
    ).toEqual(['set maxResults to 20', 'set includeCompleted to false']);
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
