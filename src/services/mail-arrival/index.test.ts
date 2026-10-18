import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { mcpLog } from '../../logging.js';
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
    expect(TypeSafeClientMock.mock.calls).toEqual([[{ apiKey: 'test-key', logLevel: 'error' }]]);
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
    expect(TypeSafeClientMock.mock.calls).toEqual([[{ apiKey: 'test-key', logLevel: 'error' }]]);
  });

  it('should construct the SDK client with the trimmed API key and logLevel error', async () => {
    await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: mockImap() as unknown as ImapService,
      apiKey: '  test-key  ',
      accounts: [account],
    });
    expect(TypeSafeClientMock.mock.calls).toEqual([[{ apiKey: 'test-key', logLevel: 'error' }]]);
  });

  it('should warn about a move_to path when the account has no such mailbox', async () => {
    await MailArrival.tryCreate({
      config: systemOneConfig(),
      imap: mockImap() as unknown as ImapService,
      apiKey: 'test-key',
      accounts: [account],
      moveToPaths: ['Archive', 'Receipts'],
    });
    const warnings = vi
      .mocked(mcpLog)
      .mock.calls.map(([, , message]) => message)
      .filter((message) => String(message).includes('move_to'));
    expect(warnings).toEqual(['system_one: unknown move_to path "Archive" on personal']);
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

  it('should ask System One with the configured model', async () => {
    const arrival = await createArrival(mockImap(), { model: 'jev-test' });
    await arrival.handle(arrivalEmail('10'));
    const payload = systemOneMock.mock.calls[0]?.[0] as { model?: string } | undefined;
    expect(payload?.model).toBe('jev-test');
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
