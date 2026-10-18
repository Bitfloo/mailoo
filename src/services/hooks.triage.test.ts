import type { Mock, MockInstance } from 'vitest';
import { mcpLog } from '../logging.js';
import { delimitUntrusted } from '../safety/untrusted-content.js';
import type { MockImap } from '../test-support/hooks-harness.js';
import { flushHooks, hooksConfig, meta, mockImap } from '../test-support/hooks-harness.js';
import type { HooksConfig } from '../types/index.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import NotifierService from './notifier.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

describe('HooksService triage', () => {
  let hooks: HooksService | undefined;
  let alert: MockInstance<NotifierService['alert']>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    alert = vi.spyOn(NotifierService.prototype, 'alert').mockResolvedValue(undefined);
  });

  afterEach(() => {
    hooks?.stop();
    hooks = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** A sampling client that answers with `results` as the triage JSON array. */
  function client(results: unknown[]): Mock {
    return vi.fn().mockResolvedValue({
      model: 'fast',
      content: { type: 'text', text: JSON.stringify(results) },
    });
  }

  async function triageOne(
    config: Partial<HooksConfig>,
    createMessage: Mock,
    sampling = true,
  ): Promise<MockImap> {
    const imap = mockImap();
    hooks = new HooksService(
      hooksConfig({ onNewEmail: 'triage', ...config }),
      imap as unknown as ImapService,
    );
    hooks.start({ createMessage } as never, { sampling });
    await flushHooks([meta({ id: '1' })]);
    return imap;
  }

  function logged(prefix: string): unknown[][] {
    return vi
      .mocked(mcpLog)
      .mock.calls.filter(([, , message]) => String(message).startsWith(prefix));
  }

  const urgent = [{ priority: 'urgent' }];

  it('should alert at normal priority without sampling when the client cannot sample', async () => {
    await triageOne({}, client(urgent), false);
    expect(alert.mock.calls.map(([payload]) => payload.priority)).toEqual(['normal']);
  });

  it('should alert at normal priority without sampling in notify mode', async () => {
    await triageOne({ onNewEmail: 'notify' }, client(urgent));
    expect(alert.mock.calls.map(([payload]) => payload.priority)).toEqual(['normal']);
  });

  it('should alert at normal priority without sampling for the notification-only preset', async () => {
    await triageOne({ preset: 'notification-only' }, client(urgent));
    expect(alert.mock.calls.map(([payload]) => payload.priority)).toEqual(['normal']);
  });

  it('should send the system prompt, the email summary and a 1000-token cap', async () => {
    const createMessage = client(urgent);
    await triageOne({ preset: 'custom', systemPrompt: 'Flag mail from the board.' }, createMessage);
    const request = createMessage.mock.calls[0]?.[0];
    expect({
      systemPrompt: request?.systemPrompt,
      maxTokens: request?.maxTokens,
      prompt: request?.messages[0].content.text,
    }).toEqual({
      systemPrompt: 'Flag mail from the board.',
      maxTokens: 1000,
      prompt: `Analyze these 1 new email(s):\n\n${delimitUntrusted(
        '[1] From: Alice\n    Subject: Hello\n    Date: 2026-09-21T00:00:00.000Z\n    Flags: \u{1F195}',
      )}`,
    });
  });

  it('should alert at normal priority when the sampling reply names no model', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: { type: 'text', text: JSON.stringify(urgent) },
    });
    await triageOne({}, createMessage);
    expect(alert.mock.calls.map(([payload]) => payload.priority)).toEqual(['normal']);
  });

  it('should alert at normal priority when sampling fails', async () => {
    await triageOne({}, vi.fn().mockRejectedValue(new Error('client went away')));
    expect(alert.mock.calls.map(([payload]) => payload.priority)).toEqual(['normal']);
  });

  it('should warn with the reason when sampling fails', async () => {
    await triageOne({}, vi.fn().mockRejectedValue(new Error('client went away')));
    expect(logged('Sampling failed')).toEqual([
      ['warning', 'hooks', 'Sampling failed: client went away — falling back to notify'],
    ]);
  });

  it.each([
    [true, [['personal', '1', 'INBOX', 'Work']]],
    [false, []],
  ] as const)('with auto_label %s, should add the triage labels %j', async (autoLabel, labels) => {
    const imap = await triageOne({ autoLabel }, client([{ labels: ['Work'] }]));
    expect(imap.addLabel.mock.calls).toEqual(labels);
  });

  it.each([
    [true, [['personal', '1', 'INBOX', 'flag']]],
    [false, []],
  ] as const)('with auto_flag %s, should set the triage flag %j', async (autoFlag, flags) => {
    const imap = await triageOne({ autoFlag }, client([{ flag: true }]));
    expect(imap.setFlags.mock.calls).toEqual(flags);
  });

  it('should alert at normal priority when the triage names none', async () => {
    await triageOne({}, client([{ labels: ['Work'] }]));
    expect(alert.mock.calls.map(([payload]) => payload.priority)).toEqual(['normal']);
  });

  it('should pass the triage labels and priority to the alert', async () => {
    await triageOne({}, client([{ priority: 'high', labels: ['Work'] }]));
    expect(alert.mock.calls[0]?.[0]).toMatchObject({
      uid: '1',
      priority: 'high',
      labels: ['Work'],
    });
  });

  it('should log the action the triage suggests', async () => {
    await triageOne({}, client([{ action: 'Reply by Friday' }]));
    expect(logged('   Action')).toEqual([['info', 'hooks', '   Action: Reply by Friday']]);
  });
});
