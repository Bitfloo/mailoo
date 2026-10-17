import { rm } from 'node:fs/promises';
import type { MockInstance } from 'vitest';
import { hooksConfig, meta, mockImap } from '../test-support/hooks-harness.js';
import type { Email, EmailMeta, HookRule } from '../types/index.js';
import { isCalendarProcessed } from '../utils/calendar-state.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import LocalCalendarService from './local-calendar.service.js';

const { stateHome, previousStateHome } = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previous = process.env.XDG_STATE_HOME;
  const dir = await mkdtemp(join(tmpdir(), 'mailoo-hooks-state-'));
  // Set before config/xdg loads: calendar-state must never write the real ~/.local/state.
  process.env.XDG_STATE_HOME = dir;
  return { stateHome: dir, previousStateHome: previous };
});

afterAll(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  await rm(stateHome, { recursive: true, force: true });
});

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

describe('HooksService calendar auto-add state', () => {
  let hooks: HooksService | undefined;
  let addEvent: MockInstance<LocalCalendarService['addEvent']>;

  const inviteRule: HookRule = {
    name: 'invites',
    match: { from: 'alice@example.com' },
    actions: { addToCalendar: true },
  };

  /** Same fields ImapService.getEmail returns for a plain-text invitation. */
  function invitation(id: string): Email {
    return {
      ...meta({ id, subject: 'Planning sync', messageId: `<plan-${id}@example.com>` }),
      bodyText: 'Join us Monday at 10:00. https://meet.example.com/abc-defg-hij',
      messageId: `<plan-${id}@example.com>`,
      attachments: [],
      headers: {},
    };
  }

  function calendarImap(email: Email | Error) {
    return {
      ...mockImap(),
      getEmail:
        email instanceof Error
          ? vi.fn().mockRejectedValue(email)
          : vi.fn().mockResolvedValue(email),
      getCalendarParts: vi.fn().mockResolvedValue([]),
      saveEmailAttachments: vi.fn().mockResolvedValue([]),
    };
  }

  /** Awaits flushBatch directly: the batch timer gives no promise to await before the state write. */
  async function runBatch(service: HooksService, emails: EmailMeta[]): Promise<void> {
    eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails });
    await (service as unknown as { flushBatch: () => Promise<void> }).flushBatch();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Never reach osascript or xdg-open: these tests must not touch a real calendar.
    addEvent = vi
      .spyOn(LocalCalendarService.prototype, 'addEvent')
      .mockResolvedValue({ status: 'added', message: 'added' });
  });

  afterEach(() => {
    hooks?.stop();
    hooks = undefined;
    vi.restoreAllMocks();
  });

  it('should leave the email unprocessed when fetching it for the calendar fails', async () => {
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
      calendarImap(new Error('IMAP connection lost')) as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await runBatch(hooks, [meta({ id: '101' })]);

    await expect(isCalendarProcessed('personal', '101')).resolves.toBe(false);
  });

  it.each([
    ['added', true],
    ['duplicate', true],
    ['cancelled', true],
    ['timed_out', false],
    ['no_display', false],
  ] as const)(
    'when a static-rule add reports %s, should mark it processed: %s',
    async (status, marked) => {
      const id = `11${['added', 'duplicate', 'cancelled', 'timed_out', 'no_display'].indexOf(status)}`;
      addEvent.mockResolvedValue({ status, message: status });
      hooks = new HooksService(
        hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
        calendarImap(invitation(id)) as unknown as ImapService,
      );
      hooks.start({} as never, { sampling: false });

      await runBatch(hooks, [meta({ id })]);

      await expect(isCalendarProcessed('personal', id)).resolves.toBe(marked);
    },
  );

  it('should leave the email unprocessed when a triage-requested add fails', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'fast',
      content: { type: 'text', text: JSON.stringify([{ add_to_calendar: true }]) },
    });
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, onNewEmail: 'triage' }),
      calendarImap(new Error('IMAP connection lost')) as unknown as ImapService,
    );
    hooks.start({ createMessage } as never, { sampling: true });

    await runBatch(hooks, [meta({ id: '121' })]);

    await expect(isCalendarProcessed('personal', '121')).resolves.toBe(false);
  });
});
