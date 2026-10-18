import { mcpLog } from '../logging.js';
import { flushHooks, hooksConfig, meta, mockImap } from '../test-support/hooks-harness.js';
import type { HookRule } from '../types/index.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import type { MailArrival } from './mail-arrival/index.js';
import NotifierService from './notifier.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

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

describe('HooksService static rule alerts', () => {
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

  async function alertFor(rule: HookRule) {
    const alert = vi.spyOn(NotifierService.prototype, 'alert').mockResolvedValue(undefined);
    hooks = new HooksService(hooksConfig({ rules: [rule] }), mockImap() as unknown as ImapService);
    hooks.start({} as never, { sampling: false });
    await flushHooks([meta()]);
    return alert.mock.calls[0];
  }

  it('should alert a flag rule at high priority with its labels and rule name', async () => {
    const [payload] =
      (await alertFor({
        name: 'board',
        match: { from: 'alice@example.com' },
        actions: { flag: true, labels: ['Board'] },
      })) ?? [];
    expect(payload).toMatchObject({
      uid: '10',
      priority: 'high',
      labels: ['Board'],
      ruleName: 'board',
    });
  });

  it('should alert a rule without flag at normal priority', async () => {
    const [payload] =
      (await alertFor({
        name: 'known',
        match: { from: 'alice@example.com' },
        actions: { labels: ['Known'] },
      })) ?? [];
    expect(payload?.priority).toBe('normal');
  });

  it.each([
    [true, true],
    [undefined, false],
  ] as const)('with alert %s, should force the notification: %s', async (alert, forced) => {
    const call = await alertFor({
      name: 'board',
      match: { from: 'alice@example.com' },
      actions: { alert },
    });
    expect(call?.[1]).toBe(forced);
  });
});
