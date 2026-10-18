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
import onDarwin from '../test-support/platform.js';
import { CONFIRM_DIALOG_WAIT_S } from './osascript.js';
import RemindersService, { ADD_REMINDER_TIMEOUT_MS } from './reminders.service.js';

async function withReminders<T>(fn: (svc: RemindersService) => Promise<T>): Promise<T> {
  return onDarwin(async () => fn(new RemindersService()));
}

beforeEach(() => {
  osascriptImpl.mockReset();
  osascriptImpl.mockResolvedValue({ stdout: '[]', stderr: '' });
});

describe('addReminder confirm dialog', () => {
  it('should show a quoted title, notes and list name in the dialog as written', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"cancelled"}', stderr: '' });
    await withReminders(async (svc) =>
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
    await withReminders(async (svc) => svc.addReminder({ title: 'Call the bank' }));
    const script = osascriptImpl.mock.calls[0]?.[1][1] ?? '';
    expect(/giving up after (\d+)/.exec(script)?.[1]).toBe(String(CONFIRM_DIALOG_WAIT_S));
  });
});

describe('addReminder due date line and properties', () => {
  it('should show the due date in the dialog', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"cancelled"}', stderr: '' });
    await withReminders(async (svc) =>
      svc.addReminder({ title: 'Call the bank', dueDate: '2026-10-05T09:00:00' }),
    );
    expect(dialogLinesOf(osascriptImpl.mock.calls[0]?.[1][1] ?? '')[1]).toBe(
      '\u{1F550} Due: 2026-10-05T09:00:00',
    );
  });

  it('should make the reminder not completed and set its due date property', async () => {
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"added"}', stderr: '' });
    await withReminders(async (svc) =>
      svc.addReminder(
        { title: 'Call the bank', dueDate: '2026-10-05T09:00:00' },
        { confirm: false },
      ),
    );
    const lines = (osascriptImpl.mock.calls[0]?.[1][1] ?? '')
      .split('\n')
      .map((line) => line.trim());
    expect({
      make: lines.find((line) => line.startsWith('set newReminder to make new reminder')),
      due: lines.filter((line) => line.endsWith('of newReminder to dueD')),
    }).toEqual({
      make: 'set newReminder to make new reminder at end of reminders of targetList with properties {name:"Call the bank", completed:false}',
      due: ['set due date of newReminder to dueD'],
    });
  });
});

describe('addReminder due date', () => {
  it('should be due on 28 February when the script runs on 31 January', async () => {
    // Setting month 2 on 31 January lands on 3 March before the day is set.
    osascriptImpl.mockResolvedValueOnce({ stdout: '{"status":"added"}', stderr: '' });
    await withReminders(async (svc) =>
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
    await withReminders(async (svc) => svc.addReminder(invoice, { confirm: false }));
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
    // The confirm dialog alone may wait CONFIRM_DIALOG_WAIT_S; a shorter budget would cut off
    // a confirmed add.
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
    return withReminders(async (svc) =>
      svc.addReminder({ title: 'Call the bank' }, { confirm: false }),
    );
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
    await withReminders(async (svc) => svc.addReminder({ title: 'Call the bank', ...input }));
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
