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
import { dateSetBy, dialogLinesOf, literalAfter } from '../test-support/applescript.js';
import { CONFIRM_DIALOG_WAIT_S } from './osascript.js';
import RemindersService, { ADD_REMINDER_TIMEOUT_MS } from './reminders.service.js';

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

describe('addReminder confirm dialog', () => {
  it('should show a quoted title, notes and list name in the dialog as written', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"cancelled"}', stderr: '' });
    await onDarwin(async (svc) =>
      svc.addReminder({
        title: 'Pay "Acme" invoice',
        notes: 'Ref C:\\billing\\"Q4"',
        listName: 'Home "Q4"',
      }),
    );
    expect(dialogLinesOf(osascriptImpl.mock.calls[0]?.[1][1] ?? '')).toEqual([
      '\u{1F514} Pay "Acme" invoice',
      '\u{1F4DD} Ref C:\\billing\\"Q4"',
      '\u{1F4CB} List: Home "Q4"',
    ]);
  });

  it('should give up the dialog after CONFIRM_DIALOG_WAIT_S seconds', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"cancelled"}', stderr: '' });
    await onDarwin(async (svc) => svc.addReminder({ title: 'Call the bank' }));
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect(/giving up after (\d+)/.exec(script)?.[1]).toBe(String(CONFIRM_DIALOG_WAIT_S));
  });
});

describe('addReminder due date', () => {
  it('should be due on 28 February when the script runs on 31 January', async () => {
    // Setting month 2 on 31 January lands on 3 March before the day is set.
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"added"}', stderr: '' });
    await onDarwin(async (svc) =>
      svc.addReminder(
        { title: 'File VAT return', dueDate: '2026-02-28T09:30:00' },
        { confirm: false },
      ),
    );
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect(dateSetBy(script, 'dueD', new Date(2026, 0, 31, 12, 0, 0))).toEqual(
      new Date(2026, 1, 28, 9, 30, 0),
    );
  });
});

describe('addReminder script', () => {
  const invoice = {
    title: 'Pay "Acme" \\ invoice',
    notes: 'Ref C:\\billing\n"Q4"',
    listName: 'Home "Q4"',
  };

  async function addScript(): Promise<string> {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"added"}', stderr: '' });
    await onDarwin(async (svc) => svc.addReminder(invoice, { confirm: false }));
    return osascriptImpl.mock.calls[0]?.[1][1] ?? '';
  }

  it('should keep a quoted title, notes and list name intact in the add script', async () => {
    const script = await addScript();
    expect({
      title: literalAfter(script, '{name:'),
      notes: literalAfter(script, 'body:'),
      list: literalAfter(script, 'set targetList to list '),
    }).toEqual({ title: invoice.title, notes: invoice.notes, list: invoice.listName });
  });

  it('should give the add reminder script a 90 s budget', async () => {
    // The confirm dialog alone may wait CONFIRM_DIALOG_WAIT_S; a shorter budget cuts off an add.
    await addScript();
    expect(osascriptImpl.mock.calls[0]?.[2].timeout).toBe(90_000);
  });

  it('should give the add reminder script more time than the confirm dialog waits', () => {
    expect(ADD_REMINDER_TIMEOUT_MS).toBeGreaterThan(CONFIRM_DIALOG_WAIT_S * 1000);
  });
});

describe('addReminder failures', () => {
  /** Adds a reminder while osascript exits non-zero with `stderr`, as execFile rejects. */
  async function addRejectedWith(stderr: string) {
    osascriptImpl.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: osascript -e set dialogText to "Call the bank"'), {
        killed: false,
        code: 1,
        stderr,
      }),
    );
    return onDarwin(async (svc) => svc.addReminder({ title: 'Call the bank' }, { confirm: false }));
  }

  it('should report an add the user cancelled (-128) as cancelled', async () => {
    await expect(
      addRejectedWith('0:208: execution error: User canceled. (-128)\n'),
    ).resolves.toEqual({ status: 'cancelled', message: 'Cancelled by user.' });
  });

  it('should report a refused add as no_display with the access-denied message', async () => {
    await expect(
      addRejectedWith(
        '0:208: execution error: Not authorized to send Apple events to Reminders. (-1743)\n',
      ),
    ).resolves.toEqual({
      status: 'no_display',
      message:
        'Reminders access denied. Go to System Settings → Privacy → Reminders and enable Terminal.',
    });
  });
});

describe('addReminder priority and notes', () => {
  /** The script for a reminder added with the confirm dialog, which the user then cancels. */
  async function dialogScript(input: {
    priority?: 'none' | 'low' | 'medium' | 'high';
    notes?: string;
  }): Promise<string> {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"cancelled"}', stderr: '' });
    await onDarwin(async (svc) => svc.addReminder({ title: 'Call the bank', ...input }));
    return osascriptImpl.mock.calls.at(-1)?.[1][1] ?? '';
  }

  it.each([
    ['high', 'High', '1'],
    ['medium', 'Medium', '5'],
    ['low', 'Low', '9'],
  ] as const)(
    'should show priority %s as %s in the dialog and send priority %s',
    async (priority, label, sent) => {
      const script = await dialogScript({ priority });
      expect({
        dialog: dialogLinesOf(script).at(-1),
        sent: /priority:(\d+)/.exec(script)?.[1],
      }).toEqual({ dialog: `⚠️ Priority: ${label}`, sent });
    },
  );

  it('should neither show nor send a priority for priority none', async () => {
    const script = await dialogScript({ priority: 'none' });
    expect({ dialog: dialogLinesOf(script), sent: script.includes('priority:') }).toEqual({
      dialog: ['\u{1F514} Call the bank'],
      sent: false,
    });
  });

  it('should cut notes after 200 characters with an ellipsis in the dialog', async () => {
    const at200 = dialogLinesOf(await dialogScript({ notes: 'a'.repeat(200) }))[1];
    const at201 = dialogLinesOf(await dialogScript({ notes: 'b'.repeat(201) }))[1];
    expect({ at200, at201 }).toEqual({
      at200: `\u{1F4DD} ${'a'.repeat(200)}`,
      at201: `\u{1F4DD} ${'b'.repeat(200)}…`,
    });
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
