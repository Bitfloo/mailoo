import { mcpLog } from '../logging.js';
import type { EmailMeta, HookRule, HooksConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import type { MailArrival } from './mail-arrival/index.js';

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
    hooks.start({ sendResourceUpdated: vi.fn().mockResolvedValue(undefined) } as never, {
      sampling: false,
    });

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
    hooks.start({ sendResourceUpdated: vi.fn().mockResolvedValue(undefined) } as never, {
      sampling: false,
    });

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
    hooks.start(
      { sendResourceUpdated: vi.fn().mockResolvedValue(undefined), createMessage } as never,
      {
        sampling: true,
      },
    );

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
    hooks.start(
      { sendResourceUpdated: vi.fn().mockResolvedValue(undefined), createMessage } as never,
      {
        sampling: true,
      },
    );

    await flushHooks([meta()]);

    expect(handle).toHaveBeenCalledOnce();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it('logs flushBatch rejection instead of swallowing it', async () => {
    const imap = mockImap();
    hooks = new HooksService(hooksConfig(), imap as unknown as ImapService);
    hooks.start({} as never, { sampling: false });

    await flushHooks([meta()]);

    expect(mcpLog).toHaveBeenCalledWith(
      'warning',
      'hooks',
      expect.stringContaining('flushBatch failed'),
    );
  });
});
