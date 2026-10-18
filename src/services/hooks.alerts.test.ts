import type { Mock, MockInstance } from 'vitest';
import { mcpLog } from '../logging.js';
import { hooksConfig, meta, mockImap } from '../test-support/hooks-harness.js';
import type { EmailMeta, HooksConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import type { MailArrival } from './mail-arrival/index.js';
import NotifierService from './notifier.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

/** Every field the alert copies holds a value that no default or other field would give. */
const contract = meta({
  id: '7',
  subject: 'Contract draft',
  from: { name: 'Bob', address: 'bob@example.com' },
  messageId: '<contract-7@example.com>',
  hasAttachments: true,
});

const fields = {
  account: 'work',
  sender: { name: 'Bob', address: 'bob@example.com' },
  subject: 'Contract draft',
  uid: '7',
  messageId: '<contract-7@example.com>',
  folder: 'Projects',
  hasAttachments: true,
};

describe('HooksService alerts', () => {
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

  function start(config: Partial<HooksConfig>, deps: { handle?: Mock; createMessage?: Mock } = {}) {
    const mailArrival = deps.handle ? ({ handle: deps.handle } as unknown as MailArrival) : null;
    hooks = new HooksService(hooksConfig(config), mockImap() as unknown as ImapService, {
      mailArrival,
    });
    hooks.start({ createMessage: deps.createMessage } as never, {
      sampling: deps.createMessage !== undefined,
    });
  }

  async function deliver(emails: EmailMeta[] = [contract]): Promise<void> {
    eventBus.emit('email:new', { account: 'work', mailbox: 'Projects', emails });
    await vi.advanceTimersByTimeAsync(1000);
  }

  function logged(prefix: string): unknown[][] {
    return vi
      .mocked(mcpLog)
      .mock.calls.filter(([, , message]) => String(message).startsWith(prefix));
  }

  it('should alert with every field of the email in notify mode', async () => {
    start({ onNewEmail: 'notify' });
    await deliver();
    expect(alert.mock.calls).toEqual([[{ ...fields, priority: 'normal' }]]);
  });

  it('should alert with every field of the email and the rule for a static rule', async () => {
    start({
      rules: [
        { name: 'contracts', match: { subject: 'Contract*' }, actions: { labels: ['Legal'] } },
      ],
    });
    await deliver();
    expect(alert.mock.calls).toEqual([
      [{ ...fields, priority: 'normal', labels: ['Legal'], ruleName: 'contracts' }, false],
    ]);
  });

  it('should alert with every field of the email and the triage result in triage mode', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'fast',
      content: { type: 'text', text: JSON.stringify([{ priority: 'high', labels: ['Legal'] }]) },
    });
    start({ onNewEmail: 'triage' }, { createMessage });
    await deliver();
    expect(alert.mock.calls).toEqual([[{ ...fields, priority: 'high', labels: ['Legal'] }]]);
  });

  it('should alert with every field of the email after the mail arrival handles it', async () => {
    start({}, { handle: vi.fn().mockResolvedValue({ kind: 'noop' }) });
    await deliver();
    expect(alert.mock.calls).toEqual([[{ ...fields, priority: 'normal' }]]);
  });

  it('should still alert and handle the next email when MailArrival.handle throws', async () => {
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error('folder index gone'))
      .mockResolvedValue({ kind: 'noop' });
    start({}, { handle });
    await deliver([contract, meta({ id: '8' })]);
    expect({
      handled: handle.mock.calls.length,
      alerted: alert.mock.calls.map(([payload]) => payload.uid),
    }).toEqual({ handled: 2, alerted: ['7', '8'] });
  });

  it('should log a warning with the reason when MailArrival.handle throws', async () => {
    start({}, { handle: vi.fn().mockRejectedValue(new Error('folder index gone')) });
    await deliver();
    expect(logged('MailArrival')).toEqual([
      ['warning', 'hooks', 'MailArrival.handle failed: folder index gone'],
    ]);
  });

  it("should not start the next flush before the previous batch's alerts have settled", async () => {
    let release = (): void => {};
    alert.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    start({ onNewEmail: 'notify' });
    await deliver();
    await deliver([meta({ id: '8' })]);
    const beforeRelease = alert.mock.calls.length;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect({ beforeRelease, after: alert.mock.calls.map(([payload]) => payload.uid) }).toEqual({
      beforeRelease: 1,
      after: ['7', '8'],
    });
  });

  it('should log a failed flush with its reason', async () => {
    alert.mockRejectedValue(new Error('alert down'));
    start({}, { handle: vi.fn().mockResolvedValue({ kind: 'noop' }) });
    await deliver();
    expect(logged('flushBatch')).toEqual([['warning', 'hooks', 'flushBatch failed: alert down']]);
  });
});
