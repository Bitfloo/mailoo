import { mcpLog } from '../../logging.js';
import audit from '../../safety/audit.js';
import type { ImapStub, SdkReply } from '../../test-support/mail-arrival-harness.js';
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

/** The default reply with some answers replaced. */
function answersWith(overrides: SdkReply['answers']): SdkReply {
  const reply = sdkAnswers();
  Object.assign(reply.answers, overrides);
  return reply;
}

// Below importanceFlagMin (3) and isCriticalMin (0.85) with the default answers.
const UNIMPORTANT = { importance: { type: 'score', score: 1, confidence: 0.8 } } as const;
// Below folderFitMin (0.85).
const NO_FOLDER_FIT = { folder_fit_receipts: { type: 'noul', noul: 0.5 } } as const;

/** The IMAP writes in the order they were made. */
function recordWrites(imap: ImapStub): unknown[][] {
  const writes: unknown[][] = [];
  imap.setFlags.mockImplementation(async (...args: unknown[]) => {
    writes.push(['setFlags', ...args]);
  });
  imap.moveEmail.mockImplementation(async (...args: unknown[]) => {
    writes.push(['moveEmail', ...args]);
  });
  return writes;
}

describe('MailArrival.handle actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemOneMock.mockResolvedValue(sdkAnswers());
  });

  it('should flag a message before moving it', async () => {
    const imap = mockImap();
    const writes = recordWrites(imap);
    await (await createArrival(imap)).handle(arrivalEmail('10'));
    expect(writes).toEqual([
      ['setFlags', 'personal', '10', 'INBOX', 'flag'],
      ['moveEmail', 'personal', '10', 'INBOX', 'Receipts'],
    ]);
  });

  it('should move a message without flagging it when the verdict only moves it', async () => {
    systemOneMock.mockResolvedValue(answersWith(UNIMPORTANT));
    const imap = mockImap();
    const writes = recordWrites(imap);
    await (await createArrival(imap)).handle(arrivalEmail('10'));
    expect(writes).toEqual([['moveEmail', 'personal', '10', 'INBOX', 'Receipts']]);
  });

  it('should flag a message without moving it when the verdict only flags it', async () => {
    systemOneMock.mockResolvedValue(answersWith(NO_FOLDER_FIT));
    const imap = mockImap();
    const writes = recordWrites(imap);
    await (await createArrival(imap)).handle(arrivalEmail('10'));
    expect(writes).toEqual([['setFlags', 'personal', '10', 'INBOX', 'flag']]);
  });

  it('should write no audit record when the verdict leaves the message alone', async () => {
    systemOneMock.mockResolvedValue(answersWith({ ...UNIMPORTANT, ...NO_FOLDER_FIT }));
    await (await createArrival(mockImap())).handle(arrivalEmail('10'));
    expect(vi.mocked(audit.log).mock.calls).toEqual([]);
  });

  it('should still resolve with the filing when the audit log rejects', async () => {
    vi.mocked(audit.log).mockRejectedValueOnce(new Error('EACCES'));
    const arrival = await createArrival(mockImap());
    await expect(arrival.handle(arrivalEmail('10'))).resolves.toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: true,
    });
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
  return answersWith({ offers_unexpected_reward: { type: 'noul', noul: 1 } });
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
