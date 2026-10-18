import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  account,
  arrivalEmail,
  createArrival,
  mockImap,
  sdkAnswers,
  systemOneConfig,
  systemOneMock,
  TypeSafeClientMock,
} from '../../test-support/mail-arrival-harness.js';
import type { AccountConfig } from '../../types/index.js';
import type ImapService from '../imap.service.js';
import { MailArrival, SEEN_LIMIT } from './index.js';

const execFileAsync = promisify(execFile);

/** Cold tsx plus the mail-arrival import graph exceeds the 10s unit default. */
const SDK_LOAD_PROBE_TIMEOUT_MS = 30_000;

vi.mock(
  '@typesafe-ai/sdk',
  async () => (await import('../../test-support/mail-arrival-harness.js')).typesafeSdkStub,
);

vi.mock('../../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../safety/audit.js', () => ({
  default: { log: vi.fn().mockResolvedValue(undefined), AUDIT_LOG_PATH: '/tmp/mailoo-audit.log' },
}));

describe('MailArrival.tryCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return null when enabled is false', async () => {
    const imap = mockImap();
    const result = await MailArrival.tryCreate({
      config: systemOneConfig({ enabled: false }),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    expect(result).toBeNull();
    expect(TypeSafeClientMock).not.toHaveBeenCalled();
    expect(imap.listMailboxes).not.toHaveBeenCalled();
  });

  it('should return null when apiKey is blank', async () => {
    const imap = mockImap();
    const result = await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: imap as unknown as ImapService,
      apiKey: '   ',
      accounts: [account],
    });
    expect(result).toBeNull();
    expect(TypeSafeClientMock).not.toHaveBeenCalled();
  });

  it('should return null when two folders share a slug', async () => {
    const imap = mockImap();
    const result = await MailArrival.tryCreate({
      config: systemOneConfig({
        folders: [
          { path: 'Foo Bar', description: 'One.' },
          { path: 'foo_bar', description: 'Two.' },
        ],
      }),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    expect(result).toBeNull();
    expect(TypeSafeClientMock).not.toHaveBeenCalled();
  });

  it('should return an instance when folders[] is empty', async () => {
    const imap = mockImap();
    const result = await MailArrival.tryCreate({
      config: systemOneConfig({ folders: [] }),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    expect(result).not.toBeNull();
    expect(TypeSafeClientMock).toHaveBeenCalledOnce();
  });

  it('should still return an instance when listMailboxes rejects', async () => {
    const imap = mockImap();
    imap.listMailboxes.mockRejectedValue(new Error('LIST failed'));
    const result = await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    expect(result).not.toBeNull();
    expect(TypeSafeClientMock).toHaveBeenCalledOnce();
  });
});

describe('MailArrival.handle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemOneMock.mockResolvedValue(sdkAnswers());
  });

  it('should flag a message before moving it', async () => {
    const imap = mockImap();
    const writes: unknown[][] = [];
    imap.setFlags.mockImplementation(async (...args: unknown[]) => {
      writes.push(['setFlags', ...args]);
    });
    imap.moveEmail.mockImplementation(async (...args: unknown[]) => {
      writes.push(['moveEmail', ...args]);
    });
    await (await createArrival(imap)).handle(arrivalEmail('10'));
    expect(writes).toEqual([
      ['setFlags', 'personal', '10', 'INBOX', 'flag'],
      ['moveEmail', 'personal', '10', 'INBOX', 'Receipts'],
    ]);
  });

  // Headers and the attachment list only: the body stays on the server while include_body is off.
  it('should not read the whole message', async () => {
    const imap = mockImap();
    await (await createArrival(imap)).handle(arrivalEmail('10'));
    expect({
      attachmentLists: imap.peekAttachments.mock.calls,
      bodies: imap.peekText.mock.calls.length,
      wholeMessages: imap.getEmail.mock.calls.length,
    }).toEqual({ attachmentLists: [['personal', '10', 'INBOX']], bodies: 0, wholeMessages: 0 });
  });

  it('should read the text part but not the whole message when include_body is true', async () => {
    const imap = mockImap();
    imap.peekText.mockResolvedValue('plain body');
    const arrival = await MailArrival.tryCreate({
      config: systemOneConfig({ includeBody: true }),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });

    if (!arrival) throw new Error('expected MailArrival instance');

    await arrival.handle({
      account: 'personal',
      mailbox: 'INBOX',
      meta: {
        id: '10',
        subject: 'Invoice',
        from: { address: 'billing@example.com' },
        to: [{ address: 'me@example.com' }],
        date: '2026-09-21T00:00:00.000Z',
        seen: false,
        flagged: false,
        answered: false,
        hasAttachments: false,
        labels: [],
      },
    });

    expect(imap.peekText).toHaveBeenCalledWith('personal', '10', 'INBOX');
    expect(imap.peekAttachments).toHaveBeenCalledWith('personal', '10', 'INBOX');
    expect(imap.getEmail).not.toHaveBeenCalled();
  });

  it('should pass peekAttachments names into systemOne state', async () => {
    const imap = mockImap();
    imap.peekAttachments.mockResolvedValue([{ filename: 'inv.pdf', mime: 'application/pdf' }]);
    const arrival = await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
    });
    if (!arrival) throw new Error('expected MailArrival instance');

    await arrival.handle({
      account: 'personal',
      mailbox: 'INBOX',
      meta: {
        id: '10',
        subject: 'Invoice',
        from: { name: 'Billing', address: 'billing@example.com' },
        to: [{ address: 'me@example.com' }],
        date: '2026-09-21T00:00:00.000Z',
        seen: false,
        flagged: false,
        answered: false,
        hasAttachments: true,
        labels: [],
        messageId: '<mid@example.com>',
      },
    });

    const payload = systemOneMock.mock.calls[0]?.[0] as
      | { state?: { message?: { attachments?: unknown } } }
      | undefined;
    expect(payload?.state?.message?.attachments).toEqual([
      { filename: 'inv.pdf', mime: 'application/pdf' },
    ]);
    expect(imap.getEmail).not.toHaveBeenCalled();
  });
});

function questionsSentAt(call: number): Record<string, unknown> | undefined {
  const payload = systemOneMock.mock.calls[call]?.[0] as
    | { questions?: Record<string, unknown> }
    | undefined;
  return payload?.questions;
}

describe('MailArrival.handle question map', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemOneMock.mockResolvedValue(sdkAnswers());
  });

  it('should ask about each configured folder that exists on the account', async () => {
    const arrival = await createArrival(mockImap());
    await arrival.handle(arrivalEmail('10', 'personal'));
    expect(Object.keys(questionsSentAt(0) ?? {}).sort()).toEqual([
      'contains_prompt_injection',
      'folder_fit_receipts',
      'importance',
      'is_critical',
      'offers_unexpected_reward',
      'requests_credentials',
      'sender_identity_mismatch',
    ]);
  });

  it('should ask only about the folders that exist on the account', async () => {
    const work: AccountConfig = {
      ...account,
      name: 'work',
      email: 'work@example.com',
      username: 'work@example.com',
    };
    const imap = mockImap();
    const inbox = { name: 'INBOX', path: 'INBOX', totalMessages: 0, unseenMessages: 0 };
    const receipts = { name: 'Receipts', path: 'Receipts', totalMessages: 0, unseenMessages: 0 };
    imap.listMailboxes.mockImplementation(async (name: string) => {
      if (name === 'work') return [inbox];
      return [inbox, receipts];
    });
    const arrival = await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: imap as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account, work],
    });
    if (!arrival) throw new Error('expected MailArrival instance');
    await arrival.handle(arrivalEmail('10', 'personal'));
    await arrival.handle(arrivalEmail('20', 'work'));
    expect(Object.keys(questionsSentAt(1) ?? {}).sort()).toEqual([
      'contains_prompt_injection',
      'importance',
      'is_critical',
      'offers_unexpected_reward',
      'requests_credentials',
      'sender_identity_mismatch',
    ]);
  });
});

function rootFromHere(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

describe('MailArrival SDK load', () => {
  it(
    'should not load @typesafe-ai/sdk when system_one is disabled',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'mailoo-sdk-load-'));
      const probe = path.join(dir, 'probe.mjs');
      const entry = pathToFileURL(path.join(rootFromHere(), 'index.ts')).href;
      await writeFile(
        probe,
        `import { registerHooks } from 'node:module';
const hits = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes('@typesafe-ai/sdk')) hits.push(specifier);
    return nextResolve(specifier, context);
  },
});
const { MailArrival } = await import(${JSON.stringify(entry)});
const created = await MailArrival.tryCreate({
  config: { enabled: false },
  imap: {},
  apiKey: 'present',
  accounts: [],
});
if (created !== null) {
  console.error('expected null');
  process.exit(2);
}
if (hits.length > 0) {
  console.error(hits.join('\\n'));
  process.exit(3);
}
`,
      );
      try {
        await execFileAsync(process.execPath, ['--import', 'tsx', probe], {
          cwd: path.join(rootFromHere(), '../../..'),
          env: { PATH: process.env.PATH ?? '', HOME: dir },
          timeout: SDK_LOAD_PROBE_TIMEOUT_MS,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    SDK_LOAD_PROBE_TIMEOUT_MS,
  );
});

describe('README System One section', () => {
  it('should state how many classified messages are remembered', async () => {
    const readme = await readFile(path.join(rootFromHere(), '../../../README.md'), 'utf8');
    expect(readme).toContain(`remembers the last ${SEEN_LIMIT} messages it classified`);
  });

  // Held by 'should classify the same Message-ID once for each account that received it'.
  it('should state that each account classifies its own copy of a message', async () => {
    const readme = await readFile(path.join(rootFromHere(), '../../../README.md'), 'utf8');
    expect(readme).toContain(
      'A message that reaches two of your accounts is classified once in each.',
    );
  });
});
