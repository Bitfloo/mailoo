import { mcpLog } from '../logging.js';
import { flushHooks, hooksConfig, meta, mockImap } from '../test-support/hooks-harness.js';
import type { EmailMeta } from '../types/index.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import type { MailArrival } from './mail-arrival/index.js';
import NotifierService from './notifier.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

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

  it('should warn once per burst however many emails are skipped', () => {
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600 }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });
    const burst = Array.from({ length: 503 }, (_, i) => meta({ id: String(i + 1) }));

    eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails: burst });

    expect(
      vi
        .mocked(mcpLog)
        .mock.calls.filter(([, , message]) => String(message).startsWith('Hook queue full')),
    ).toHaveLength(1);
  });

  it('should leave no timer pending after stop', () => {
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600 }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });
    eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails: [meta()] });

    hooks.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('should not handle mail queued before stop once the service starts again', async () => {
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
    eventBus.emit('email:new', {
      account: 'personal',
      mailbox: 'INBOX',
      emails: [meta({ id: '1' })],
    });

    hooks.stop();
    hooks.start({} as never, { sampling: false });
    eventBus.emit('email:new', {
      account: 'personal',
      mailbox: 'INBOX',
      emails: [meta({ id: '2' })],
    });
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(handled).toEqual(['2']);
  });

  /** A MailArrival that records the id of each email it handles. */
  function recorder(handled: string[]): { mailArrival: MailArrival } {
    return {
      mailArrival: {
        handle: async (email: { meta: EmailMeta }) => {
          handled.push(email.meta.id);
          return { kind: 'noop' };
        },
      } as unknown as MailArrival,
    };
  }

  it('should flush a batch once batch_delay has passed and not a millisecond before', async () => {
    const handled: string[] = [];
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3 }),
      mockImap() as unknown as ImapService,
      recorder(handled),
    );
    hooks.start({} as never, { sampling: false });
    eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails: [meta()] });

    await vi.advanceTimersByTimeAsync(2999);
    const before = [...handled];
    await vi.advanceTimersByTimeAsync(1);

    expect({ before, after: handled }).toEqual({ before: [], after: ['10'] });
  });

  it('should warn when exactly one email is over the cap', () => {
    hooks = new HooksService(
      hooksConfig({ batchDelay: 3600 }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });
    const burst = Array.from({ length: 501 }, (_, i) => meta({ id: String(i + 1) }));

    eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails: burst });

    expect(
      vi
        .mocked(mcpLog)
        .mock.calls.filter(([, , message]) => String(message).startsWith('Hook queue full')),
    ).toEqual([
      ['warning', 'hooks', 'Hook queue full (500): skipped 1 new email(s) in personal/INBOX'],
    ]);
  });

  it('should handle a mail once when start is called twice', async () => {
    const handled: string[] = [];
    hooks = new HooksService(
      hooksConfig(),
      mockImap() as unknown as ImapService,
      recorder(handled),
    );
    hooks.start({} as never, { sampling: false });
    hooks.start({} as never, { sampling: false });

    await flushHooks([meta({ id: '1' })]);

    expect(handled).toEqual(['1']);
  });

  it('should unsubscribe from email:new on stop', async () => {
    const handled: string[] = [];
    hooks = new HooksService(
      hooksConfig(),
      mockImap() as unknown as ImapService,
      recorder(handled),
    );
    hooks.start({} as never, { sampling: false });

    hooks.stop();
    await flushHooks([meta({ id: '1' })]);

    expect(handled).toEqual([]);
  });

  /** A sampling client that triages every email as urgent. */
  function urgentClient() {
    return vi.fn().mockResolvedValue({
      model: 'fast',
      content: { type: 'text', text: JSON.stringify([{ priority: 'urgent' }]) },
    });
  }

  /** Flushes one batch per id, in order; each flush takes the 1 s batch delay. */
  async function flushEach(ids: string[]): Promise<void> {
    await ids.reduce(async (previous, id) => {
      await previous;
      await flushHooks([meta({ id })]);
    }, Promise.resolve());
  }

  it('should sample at most 10 batches a minute and 10 more after the 60 s reset', async () => {
    vi.spyOn(NotifierService.prototype, 'alert').mockResolvedValue(undefined);
    const createMessage = urgentClient();
    hooks = new HooksService(
      hooksConfig({ onNewEmail: 'triage' }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({ createMessage } as never, { sampling: true });
    const ids = Array.from({ length: 22 }, (_, i) => String(i + 1));

    await flushEach(ids.slice(0, 11));
    const firstMinute = createMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000 - 11_000);
    await flushEach(ids.slice(11));

    expect({ firstMinute, total: createMessage.mock.calls.length }).toEqual({
      firstMinute: 10,
      total: 20,
    });
  });

  it('should fall back to a plain notify once the sampling limit is reached', async () => {
    const alert = vi.spyOn(NotifierService.prototype, 'alert').mockResolvedValue(undefined);
    hooks = new HooksService(
      hooksConfig({ onNewEmail: 'triage' }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({ createMessage: urgentClient() } as never, { sampling: true });

    await flushEach(Array.from({ length: 11 }, (_, i) => String(i + 1)));

    expect({
      eleventh: alert.mock.calls.at(-1)?.[0],
      warned: vi
        .mocked(mcpLog)
        .mock.calls.filter(([, , message]) => String(message).startsWith('Sampling rate limit')),
    }).toMatchObject({
      eleventh: { uid: '11', priority: 'normal' },
      warned: [['warning', 'hooks', 'Sampling rate limit reached — falling back to notify']],
    });
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
