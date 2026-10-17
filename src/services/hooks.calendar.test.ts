import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { MockInstance } from 'vitest';
import { mcpLog } from '../logging.js';
import {
  calendarImap,
  hooksConfig,
  invitation,
  meta,
  runBatch,
} from '../test-support/hooks-harness.js';
import type { Email, HookRule, HooksConfig } from '../types/index.js';
import { isCalendarProcessed } from '../utils/calendar-state.js';
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
    ['added', true, '110'],
    ['duplicate', true, '111'],
    ['cancelled', true, '112'],
    ['timed_out', false, '113'],
    ['no_display', false, '114'],
  ] as const)(
    'when a static-rule add reports %s, should mark it processed: %s',
    async (status, marked, id) => {
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

  it('should not add an email to the calendar again once it was processed', async () => {
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
      calendarImap(invitation('130')) as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await runBatch(hooks, [meta({ id: '130' })]);
    await runBatch(hooks, [meta({ id: '130' })]);

    expect(addEvent.mock.calls).toHaveLength(1);
  });

  it.each([
    ['timed_out', 'warning', '140'],
    ['no_display', 'warning', '141'],
    ['added', 'info', '142'],
  ] as const)('should log a calendar add that reports %s at %s', async (status, level, id) => {
    addEvent.mockResolvedValue({ status, message: `Calendar reported ${status}` });
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
      calendarImap(invitation(id)) as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await runBatch(hooks, [meta({ id })]);

    expect(
      vi
        .mocked(mcpLog)
        .mock.calls.filter(([, , message]) => String(message).startsWith('Calendar: ')),
    ).toEqual([[level, 'hooks', `Calendar: Calendar reported ${status}`]]);
  });

  function calendarLogs() {
    return vi
      .mocked(mcpLog)
      .mock.calls.filter(([, , message]) => String(message).startsWith('Calendar'));
  }

  function startStatic(email: Email): HooksService {
    const service = new HooksService(
      hooksConfig({ batchDelay: 3600, rules: [inviteRule] }),
      calendarImap(email) as unknown as ImapService,
    );
    service.start({} as never, { sampling: false });
    hooks = service;
    return service;
  }

  /** Starts triage with a client whose sampling reply is `triage` for the one email. */
  function startTriage(
    email: Email,
    triage: Record<string, unknown>,
    config: Partial<HooksConfig> = {},
  ): HooksService {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'fast',
      content: { type: 'text', text: JSON.stringify([triage]) },
    });
    const service = new HooksService(
      hooksConfig({ batchDelay: 3600, onNewEmail: 'triage', ...config }),
      calendarImap(email) as unknown as ImapService,
    );
    service.start({ createMessage } as never, { sampling: true });
    hooks = service;
    return service;
  }

  it('when a triage-requested add reports added, should mark it processed and skip it on a second pass', async () => {
    const service = startTriage(invitation('160'), { add_to_calendar: true });

    await runBatch(service, [meta({ id: '160' })]);
    await runBatch(service, [meta({ id: '160' })]);

    expect(addEvent.mock.calls).toHaveLength(1);
  });

  it('should not add when triage says add_to_calendar false although auto_calendar is on', async () => {
    const service = startTriage(
      invitation('161'),
      { add_to_calendar: false },
      { autoCalendar: true },
    );

    await runBatch(service, [meta({ id: '161' })]);

    expect(addEvent.mock.calls).toHaveLength(0);
  });

  it('should add when auto_calendar is on and triage says nothing about the calendar', async () => {
    const service = startTriage(invitation('162'), { priority: 'normal' }, { autoCalendar: true });

    await runBatch(service, [meta({ id: '162' })]);

    expect(addEvent.mock.calls).toHaveLength(1);
  });

  it('should log the reason when a static rule meets an email it already processed', async () => {
    const service = startStatic(invitation('163'));
    await runBatch(service, [meta({ id: '163' })]);
    vi.mocked(mcpLog).mockClear();

    await runBatch(service, [meta({ id: '163' })]);

    expect(calendarLogs()).toEqual([
      ['info', 'hooks', 'Calendar: skipping auto-add for 163 (already processed once)'],
    ]);
  });

  it('should tell the user to ask again when triage meets an email it already processed', async () => {
    const service = startTriage(invitation('164'), { add_to_calendar: true });
    await runBatch(service, [meta({ id: '164' })]);
    vi.mocked(mcpLog).mockClear();

    await runBatch(service, [meta({ id: '164' })]);

    expect(calendarLogs()).toEqual([
      [
        'info',
        'hooks',
        'Calendar: skipping auto-add for 164 (already processed once — instruct AI to add again)',
      ],
    ]);
  });

  it('should record the processed email as an event with its subject in calendar-processed.json', async () => {
    const service = startStatic(invitation('165'));

    await runBatch(service, [meta({ id: '165', subject: 'Planning sync' })]);

    const state = JSON.parse(
      await readFile(path.join(stateHome, 'mailoo', 'calendar-processed.json'), 'utf8'),
    ) as { processedEmails: Record<string, unknown> };
    expect(state.processedEmails.personal__165).toMatchObject({
      action: 'event',
      title: 'Planning sync',
    });
  });

  it('should log a calendar add that throws at warning', async () => {
    addEvent.mockRejectedValue(new Error('Calendar got an error: Connection is invalid.'));
    const service = startStatic(invitation('166'));

    await runBatch(service, [meta({ id: '166' })]);

    expect(calendarLogs()).toEqual([
      [
        'warning',
        'hooks',
        'Calendar auto-add failed: Calendar got an error: Connection is invalid.',
      ],
    ]);
  });
});
