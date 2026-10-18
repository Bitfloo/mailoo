import { mcpLog } from '../../logging.js';
import audit from '../../safety/audit.js';
import type { SdkReply } from '../../test-support/mail-arrival-harness.js';
import {
  arrivalEmail,
  createArrival,
  mockImap,
  sdkAnswers,
  systemOneConfig,
  systemOneMock,
} from '../../test-support/mail-arrival-harness.js';

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

describe('MailArrival.handle actions', () => {
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

  it('should still move a message when flagging it failed', async () => {
    const imap = mockImap();
    imap.setFlags.mockRejectedValue(new Error('STORE failed'));
    await (await createArrival(imap)).handle(arrivalEmail('10'));
    expect(imap.moveEmail.mock.calls).toEqual([['personal', '10', 'INBOX', 'Receipts']]);
  });

  it('should still flag a message when moving it failed', async () => {
    const imap = mockImap();
    imap.moveEmail.mockRejectedValue(new Error('MOVE failed'));
    await (await createArrival(imap)).handle(arrivalEmail('10'));
    expect(imap.setFlags.mock.calls).toEqual([['personal', '10', 'INBOX', 'flag']]);
  });

  it('should record the filing in the audit log', async () => {
    await (await createArrival(mockImap())).handle(arrivalEmail('10'));
    expect(vi.mocked(audit.log).mock.calls).toEqual([
      [
        'mail_arrival',
        'personal',
        { uid: '10', mailbox: 'INBOX', destination: 'Receipts', flag: true },
        'ok',
      ],
    ]);
  });
});

/** An unexpected reward alone weighs 0.25 in the spam score; no other spam signal is set. */
function rewardOnlyAnswers(): SdkReply {
  const reply = sdkAnswers();
  reply.answers.offers_unexpected_reward = { type: 'noul', noul: 1 };
  return reply;
}

function spamWarnings(): unknown[] {
  return vi
    .mocked(mcpLog)
    .mock.calls.filter(([, , message]) => String(message).startsWith('spam_high'))
    .map(([, , message]) => message);
}

describe('MailArrival.handle spam warning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemOneMock.mockResolvedValue(rewardOnlyAnswers());
  });

  it('should warn about a message when its spam score reaches spam_high', async () => {
    const thresholds = { ...systemOneConfig().thresholds, spamHigh: 0.25 };
    await (await createArrival(mockImap(), { thresholds })).handle(arrivalEmail('10'));
    expect(spamWarnings()).toEqual(['spam_high account=personal uid=10 mailbox=INBOX']);
  });

  it('should not warn about a message when its spam score is just below spam_high', async () => {
    const thresholds = { ...systemOneConfig().thresholds, spamHigh: 0.26 };
    await (await createArrival(mockImap(), { thresholds })).handle(arrivalEmail('10'));
    expect(spamWarnings()).toEqual([]);
  });
});
