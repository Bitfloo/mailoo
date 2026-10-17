import { rm } from 'node:fs/promises';
import type { MockInstance } from 'vitest';
import { mcpLog } from '../logging.js';
import type { Email, EmailMeta, HookRule, HooksConfig } from '../types/index.js';
import { isCalendarProcessed } from '../utils/calendar-state.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import LocalCalendarService from './local-calendar.service.js';
import type { MailArrival } from './mail-arrival/index.js';
import NotifierService from './notifier.service.js';

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

const alerts = {
  desktop: false,
  sound: false,
  urgencyThreshold: 'high' as const,
  webhookUrl: '',
  webhookEvents: ['urgent' as const, 'high' as const],
};

function hooksConfig(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    onNewEmail: 'notify',
    preset: 'priority-focus',
    autoLabel: false,
    autoFlag: false,
    batchDelay: 1,
    rules: [],
    alerts,
    ...overrides,
  };
}

function meta(overrides: Partial<EmailMeta> = {}): EmailMeta {
  return {
    id: '10',
    subject: 'Hello',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: 'me@example.com' }],
    date: '2026-09-21T00:00:00.000Z',
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    ...overrides,
  };
}

function mockImap() {
  return {
    addLabel: vi.fn().mockResolvedValue(undefined),
    setFlags: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    getEmail: vi.fn(),
  };
}

async function flushHooks(emails: EmailMeta[], mailbox = 'INBOX'): Promise<void> {
  eventBus.emit('email:new', { account: 'personal', mailbox, emails });
  await vi.advanceTimersByTimeAsync(1000);
}

describe('HooksService.matchStaticRules from.address', () => {
  const rule: HookRule = {
    name: 'known-alice',
    match: { from: 'alice@example.com' },
    actions: { labels: ['known'] },
  };

  it('matches the envelope address', () => {
    const outcome = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: meta() },
      [rule],
    );
    expect(outcome.matched).toBe(true);
  });

  it('does not match a display-name spoof on a different address', () => {
    const globRule: HookRule = {
      name: 'alice-glob',
      match: { from: 'alice@example.com*' },
      actions: {},
    };
    const spoof = meta({
      from: { name: 'alice@example.com', address: 'mallory@example.com' },
    });
    const exact = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: spoof },
      [rule],
    );
    const glob = HooksService.matchStaticRules(
      { account: 'personal', mailbox: 'INBOX', meta: spoof },
      [globRule],
    );
    expect(exact.matched).toBe(false);
    expect(glob.matched).toBe(false);
  });
});

describe('HooksService IMAP apply', () => {
  let hooks: HooksService | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    hooks?.stop();
    hooks = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('calls setFlags(account, emailId, mailbox, action) at flag and markRead sites', async () => {
    const imap = mockImap();
    hooks = new HooksService(
      hooksConfig({
        rules: [
          {
            name: 'flag-read',
            match: { from: 'alice@example.com' },
            actions: { flag: true, markRead: true },
          },
        ],
      }),
      imap as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await flushHooks([meta()]);

    expect(imap.setFlags).toHaveBeenCalledWith('personal', '10', 'INBOX', 'flag');
    expect(imap.setFlags).toHaveBeenCalledWith('personal', '10', 'INBOX', 'read');
    expect(imap.setFlags).not.toHaveBeenCalledWith('personal', 'INBOX', '10', expect.anything());
  });

  it('STOREs flag then MOVEs on static move_to', async () => {
    const imap = mockImap();
    hooks = new HooksService(
      hooksConfig({
        rules: [
          {
            name: 'receipts-vendor',
            match: { from: 'billing@example.com' },
            actions: { flag: true, moveTo: 'Receipts' },
          },
        ],
      }),
      imap as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });

    await flushHooks([meta({ from: { address: 'billing@example.com' } })]);

    expect(imap.setFlags).toHaveBeenCalledWith('personal', '10', 'INBOX', 'flag');
    expect(imap.moveEmail).toHaveBeenCalledWith('personal', '10', 'INBOX', 'Receipts');
    expect(imap.setFlags.mock.invocationCallOrder[0]).toBeLessThan(
      imap.moveEmail.mock.invocationCallOrder[0],
    );
  });

  it('calls setFlags(account, emailId, mailbox, flag) from the triage site', async () => {
    const imap = mockImap();
    const createMessage = vi.fn().mockResolvedValue({
      model: 'fast',
      content: { type: 'text', text: JSON.stringify([{ flag: true, labels: [] }]) },
    });
    hooks = new HooksService(
      hooksConfig({ onNewEmail: 'triage', autoFlag: true }),
      imap as unknown as ImapService,
    );
    hooks.start({ createMessage } as never, {
      sampling: true,
    });

    await flushHooks([meta()]);

    expect(createMessage).toHaveBeenCalled();
    expect(imap.setFlags).toHaveBeenCalledWith('personal', '10', 'INBOX', 'flag');
    expect(imap.setFlags).not.toHaveBeenCalledWith('personal', 'INBOX', '10', expect.anything());
  });

  it('XORs MailArrival.handle against triageBatch createMessage', async () => {
    const imap = mockImap();
    const createMessage = vi.fn();
    const handle = vi.fn().mockResolvedValue({ kind: 'noop', reason: 'no_folder_fit' });
    hooks = new HooksService(
      hooksConfig({ onNewEmail: 'triage' }),
      imap as unknown as ImapService,
      { mailArrival: { handle } as unknown as MailArrival },
    );
    hooks.start({ createMessage } as never, {
      sampling: true,
    });

    await flushHooks([meta()]);

    expect(handle).toHaveBeenCalledOnce();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('logs flushBatch rejection instead of swallowing it', async () => {
    const imap = mockImap();
    vi.spyOn(NotifierService.prototype, 'alert').mockRejectedValue(new Error('alert down'));
    hooks = new HooksService(hooksConfig(), imap as unknown as ImapService, {
      mailArrival: { handle: async () => ({ kind: 'noop' }) } as unknown as MailArrival,
    });
    hooks.start({} as never, { sampling: false });

    await flushHooks([meta()]);

    expect(mcpLog).toHaveBeenCalledWith(
      'warning',
      'hooks',
      expect.stringContaining('flushBatch failed'),
    );
  });
});

describe('HooksService batch queue', () => {
  let hooks: HooksService | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    hooks?.stop();
    hooks = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should not start a second flush while the first is still handling mail', async () => {
    const trace: string[] = [];
    const releases: (() => void)[] = [];
    const handle = vi.fn(async (email: { meta: EmailMeta }) => {
      trace.push(`start ${email.meta.id}`);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      trace.push(`end ${email.meta.id}`);
      return { kind: 'noop' };
    });
    hooks = new HooksService(hooksConfig(), mockImap() as unknown as ImapService, {
      mailArrival: { handle } as unknown as MailArrival,
    });
    hooks.start({} as never, { sampling: false });

    await flushHooks([meta({ id: '1' })]);
    await flushHooks([meta({ id: '2' })]);
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(trace).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('should keep only the first queued emails when a burst exceeds the cap', async () => {
    const handled: string[] = [];
    const handle = vi.fn(async (email: { meta: EmailMeta }) => {
      handled.push(email.meta.id);
      return { kind: 'noop' };
    });
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600 }),
      mockImap() as unknown as ImapService,
      { mailArrival: { handle } as unknown as MailArrival },
    );
    hooks.start({} as never, { sampling: false });
    const burst = Array.from({ length: 600 }, (_, i) => meta({ id: String(i + 1) }));

    eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails: burst });
    // Private on purpose; the batch timer is an hour away and gives no promise to await.
    await (hooks as unknown as { flushBatch: () => Promise<void> }).flushBatch();

    expect({ count: handled.length, first: handled[0], last: handled.at(-1) }).toEqual({
      count: 500,
      first: '1',
      last: '500',
    });
  });

  it('should warn with the account, mailbox and skipped count when the queue is full', async () => {
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600 }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });
    const burst = Array.from({ length: 503 }, (_, i) => meta({ id: String(i + 1) }));

    eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails: burst });

    expect(mcpLog).toHaveBeenCalledWith(
      'warning',
      'hooks',
      'Hook queue full (500): skipped 3 new email(s) in personal/INBOX',
    );
  });

  it('should keep processing later batches after one flush fails', async () => {
    const handled: string[] = [];
    vi.spyOn(NotifierService.prototype, 'alert')
      .mockRejectedValueOnce(new Error('alert down'))
      .mockResolvedValue(undefined);
    hooks = new HooksService(hooksConfig(), mockImap() as unknown as ImapService, {
      mailArrival: {
        handle: async (email: { meta: EmailMeta }) => {
          handled.push(email.meta.id);
          return { kind: 'noop' };
        },
      } as unknown as MailArrival,
    });
    hooks.start({} as never, { sampling: false });

    await flushHooks([meta({ id: '1' })]);
    await flushHooks([meta({ id: '2' })]);

    expect(handled).toEqual(['1', '2']);
  });

  it('should count a second burst against the 500 already queued', async () => {
    const handled: string[] = [];
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600 }),
      mockImap() as unknown as ImapService,
      {
        mailArrival: {
          handle: async (email: { meta: EmailMeta }) => {
            handled.push(email.meta.id);
            return { kind: 'noop' };
          },
        } as unknown as MailArrival,
      },
    );
    hooks.start({} as never, { sampling: false });
    const ids = Array.from({ length: 600 }, (_, i) => String(i + 1));

    eventBus.emit('email:new', {
      account: 'personal',
      mailbox: 'INBOX',
      emails: ids.slice(0, 300).map((id) => meta({ id })),
    });
    eventBus.emit('email:new', {
      account: 'personal',
      mailbox: 'INBOX',
      emails: ids.slice(300).map((id) => meta({ id })),
    });
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(handled).toEqual(ids.slice(0, 500));
  });

  it('should not warn when the burst fits the queue', () => {
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600 }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });
    const burst = Array.from({ length: 500 }, (_, i) => meta({ id: String(i + 1) }));

    eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails: burst });

    expect(
      vi
        .mocked(mcpLog)
        .mock.calls.filter(([, , message]) => String(message).startsWith('Hook queue full')),
    ).toEqual([]);
  });

  it('should not keep the process alive with the rate-limit reset interval', () => {
    vi.useRealTimers();
    hooks = new HooksService(hooksConfig(), mockImap() as unknown as ImapService);
    hooks.start({} as never, { sampling: false });

    // Private on purpose: hasRef() is the only observable of an unref'd interval in-process.
    const timer = (hooks as unknown as { rateResetTimer: NodeJS.Timeout }).rateResetTimer;

    expect(timer.hasRef()).toBe(false);
  });
});

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
