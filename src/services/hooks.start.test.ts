import type { Mock } from 'vitest';
import { mcpLog } from '../logging.js';
import { flushHooks, hooksConfig, meta, mockImap } from '../test-support/hooks-harness.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import type { MailArrival } from './mail-arrival/index.js';
import NotifierService from './notifier.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

describe('HooksService start and sampling target', () => {
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

  function logged(prefix: string): unknown[][] {
    return vi
      .mocked(mcpLog)
      .mock.calls.filter(([, , message]) => String(message).startsWith(prefix));
  }

  const arrival = { handle: vi.fn() } as unknown as MailArrival;

  it('should warn that it does not subscribe when on_new_email is none and system one is on', () => {
    hooks = new HooksService(hooksConfig({ onNewEmail: 'none' }), mockImap() as never, {
      mailArrival: arrival,
    });
    hooks.start({} as never, { sampling: false });
    expect(logged('system_one')).toEqual([
      ['warning', 'hooks', 'system_one is enabled but on_new_email is none — not subscribing'],
    ]);
  });

  it('should not warn when on_new_email is none and system one is off', () => {
    hooks = new HooksService(hooksConfig({ onNewEmail: 'none' }), mockImap() as never);
    hooks.start({} as never, { sampling: false });
    expect(vi.mocked(mcpLog).mock.calls).toEqual([]);
  });

  it.each([
    [true, 'Hooks active: mode=triage, preset=custom, rules=2, sampling=yes'],
    [false, 'Hooks active: mode=triage, preset=custom, rules=2, sampling=no'],
  ])(
    'with sampling %s, should log the mode, preset, rule count and sampling on start',
    (sampling, text) => {
      const rule = { name: 'r', match: { subject: 'x' }, actions: {} };
      hooks = new HooksService(
        hooksConfig({
          onNewEmail: 'triage',
          preset: 'custom',
          rules: [rule, { ...rule, name: 's' }],
        }),
        mockImap() as never,
      );
      hooks.start({} as never, { sampling });
      expect(logged('Hooks active')).toEqual([['info', 'hooks', text]]);
    },
  );

  /** A sampling client that triages every email as urgent. */
  function urgentClient(): Mock {
    return vi.fn().mockResolvedValue({
      model: 'fast',
      content: { type: 'text', text: JSON.stringify([{ priority: 'urgent' }]) },
    });
  }

  it('should notify at normal priority without trying to sample once the sampling target is null', async () => {
    const alert = vi.spyOn(NotifierService.prototype, 'alert').mockResolvedValue(undefined);
    const createMessage = urgentClient();
    hooks = new HooksService(
      hooksConfig({ onNewEmail: 'triage' }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({ createMessage } as never, { sampling: true });
    hooks.setSamplingTarget(null);
    await flushHooks([meta({ id: '1' })]);
    expect({
      sampled: createMessage.mock.calls.length,
      priorities: alert.mock.calls.map(([payload]) => payload.priority),
      samplingLogs: logged('Sampling'),
    }).toEqual({ sampled: 0, priorities: ['normal'], samplingLogs: [] });
  });

  it('should sample through a target set after a start without sampling', async () => {
    vi.spyOn(NotifierService.prototype, 'alert').mockResolvedValue(undefined);
    const createMessage = urgentClient();
    hooks = new HooksService(
      hooksConfig({ onNewEmail: 'triage' }),
      mockImap() as unknown as ImapService,
    );
    hooks.start({} as never, { sampling: false });
    hooks.setSamplingTarget({ createMessage } as never);
    await flushHooks([meta({ id: '1' })]);
    expect(createMessage.mock.calls).toHaveLength(1);
  });
});
