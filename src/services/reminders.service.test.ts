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

import { dateSetBy, dialogLinesOf, literalAfter } from '../test-support/applescript.js';
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

  it('should return the id and list name the script reports for an added reminder', async () => {
    osascriptImpl.mockResolvedValueOnce({
      stdout:
        '{"status":"added","reminderId":"x-apple-reminder://R2","listName":"Home \\"Q4\\""}\n',
      stderr: '',
    });
    const result = await onDarwin(async (svc) =>
      svc.addReminder({ title: 'Call the bank' }, { confirm: false }),
    );
    expect({ id: result.reminderId, list: result.listName, status: result.status }).toEqual({
      id: 'x-apple-reminder://R2',
      list: 'Home "Q4"',
      status: 'added',
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
    // The confirm dialog alone may wait 60 s; a shorter budget would cut off a confirmed add.
    await addScript();
    expect(osascriptImpl.mock.calls[0]?.[2].timeout).toBe(90_000);
  });
});
