import { mcpLog } from '../logging.js';
import { flushHooks, hooksConfig, meta, mockImap } from '../test-support/hooks-harness.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import NotifierService from './notifier.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

describe('HooksService sampling limiter', () => {
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

  /** A sampling client that triages every email as urgent. */
  function urgentClient() {
    return vi.fn().mockResolvedValue({
      model: 'fast',
      content: { type: 'text', text: JSON.stringify([{ priority: 'urgent' }]) },
    });
  }

  /** Flushes one batch per id, in order; each flush takes the 1 s batch delay. */
  async function flushEach(ids: string[]): Promise<void> {
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop -- each batch waits for the previous flush.
      await flushHooks([meta({ id })]);
    }
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

  function startTriage() {
    vi.spyOn(NotifierService.prototype, 'alert').mockResolvedValue(undefined);
    const createMessage = urgentClient();
    hooks = new HooksService(
      hooksConfig({ onNewEmail: 'triage' }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({ createMessage } as never, { sampling: true });
    return createMessage;
  }

  it('should not sample an eleventh batch that flushes 1 ms before the 60 s reset', async () => {
    const createMessage = startTriage();
    await flushEach(Array.from({ length: 10 }, (_, i) => String(i + 1)));

    // Emitted at 58 999 ms, the batch flushes at 59 999 ms, one tick before the reset.
    await vi.advanceTimersByTimeAsync(58_999 - 10_000);
    await flushEach(['11']);

    expect(createMessage.mock.calls).toHaveLength(10);
  });

  it('should sample an eleventh batch that flushes exactly at the 60 s reset', async () => {
    const createMessage = startTriage();
    await flushEach(Array.from({ length: 10 }, (_, i) => String(i + 1)));

    // Emitted at 59 000 ms, the batch flushes at 60 000 ms; the reset interval, armed first, runs first.
    await vi.advanceTimersByTimeAsync(59_000 - 10_000);
    await flushEach(['11']);

    expect(createMessage.mock.calls).toHaveLength(11);
  });

  it('should reset the sampling limit every minute, not once', async () => {
    const createMessage = startTriage();
    const perMinute: number[] = [];

    for (let minute = 0; minute < 3; minute += 1) {
      // eslint-disable-next-line no-await-in-loop -- each minute starts after the last.
      await flushEach(Array.from({ length: 11 }, (_, i) => `${minute}-${i}`));
      perMinute.push(createMessage.mock.calls.length);
      // eslint-disable-next-line no-await-in-loop -- the reset falls between the minutes.
      await vi.advanceTimersByTimeAsync(60_000 - 11_000);
    }

    expect(perMinute).toEqual([10, 20, 30]);
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
