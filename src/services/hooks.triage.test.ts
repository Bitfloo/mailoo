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
    { sampling = true, emails = [meta({ id: '1' })], imap = mockImap() } = {},
  ): Promise<MockImap> {
    hooks = new HooksService(
      hooksConfig({ onNewEmail: 'triage', ...config }),
      imap as unknown as ImapService,
    );
    hooks.start({ createMessage } as never, { sampling });
    await flushHooks(emails);
    return imap;
  }

  const two = [meta({ id: '1' }), meta({ id: '2', subject: 'Second' })];

  function logged(prefix: string): unknown[][] {
    return vi
      .mocked(mcpLog)
      .mock.calls.filter(([, , message]) => String(message).startsWith(prefix));
  }

  const urgent = [{ priority: 'urgent' }];

  it('should alert at normal priority without sampling when the client cannot sample', async () => {
    await triageOne({}, client(urgent), { sampling: false });
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

  it('should log no action when the triage suggests none', async () => {
    await triageOne({}, client([{ priority: 'low' }]));
    expect(logged('   Action')).toEqual([]);
  });

  it('should send the emails as a user message with the fast model hint and priorities', async () => {
    const createMessage = client(urgent);
    await triageOne({}, createMessage);
    const request = createMessage.mock.calls[0]?.[0];
    expect({ role: request?.messages[0].role, preferences: request?.modelPreferences }).toEqual({
      role: 'user',
      preferences: { hints: [{ name: 'fast' }], speedPriority: 0.8, intelligencePriority: 0.5 },
    });
  });

  it('should separate the summaries of two emails by a blank line', async () => {
    const createMessage = client([{}, {}]);
    await triageOne({}, createMessage, { emails: two });
    const summary = (index: number, subject: string) =>
      delimitUntrusted(
        `[${index}] From: Alice\n    Subject: ${subject}\n    Date: 2026-09-21T00:00:00.000Z\n    Flags: \u{1F195}`,
      );
    expect(createMessage.mock.calls[0]?.[0].messages[0].content.text).toBe(
      `Analyze these 2 new email(s):\n\n${summary(1, 'Hello')}\n\n${summary(2, 'Second')}`,
    );
  });

  it('should not ask the client when the custom system prompt is empty', async () => {
    const createMessage = client(urgent);
    await triageOne({ preset: 'custom', systemPrompt: '' }, createMessage);
    expect(createMessage.mock.calls).toEqual([]);
  });

  it('should alert every email when the reply holds fewer results than emails', async () => {
    await triageOne({}, client([{ priority: 'high' }]), { emails: two });
    expect(alert.mock.calls.map(([payload]) => [payload.uid, payload.priority])).toEqual([
      ['1', 'high'],
      ['2', 'normal'],
    ]);
  });

  it('should flag only the emails triage flags when auto_flag is on', async () => {
    const createMessage = client([{ flag: true }, { flag: false }]);
    const imap = await triageOne({ autoFlag: true }, createMessage, { emails: two });
    expect(imap.setFlags.mock.calls).toEqual([['personal', '1', 'INBOX', 'flag']]);
  });

  it('should add every triage label when auto_label is on', async () => {
    const imap = await triageOne({ autoLabel: true }, client([{ labels: ['Work', 'Q4'] }]));
    expect(imap.addLabel.mock.calls).toEqual([
      ['personal', '1', 'INBOX', 'Work'],
      ['personal', '1', 'INBOX', 'Q4'],
    ]);
  });

  it.each<['addLabel' | 'setFlags', Partial<HooksConfig>, unknown[], string]>([
    [
      'addLabel',
      { autoLabel: true },
      [{ labels: ['Work'] }],
      'Could not add label "Work" to email 1',
    ],
    ['setFlags', { autoFlag: true }, [{ flag: true }], 'Could not flag email 1'],
  ])(
    'should log a warning when %s fails for a triaged email',
    async (method, config, reply, text) => {
      const imap = mockImap();
      imap[method].mockRejectedValue(new Error('NO [CANNOT] refused'));
      await triageOne(config, client(reply), { imap });
      expect(logged('Could not')).toEqual([['warning', 'hooks', text]]);
    },
  );
});
