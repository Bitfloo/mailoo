import type { SdkReply } from '../../test-support/mail-arrival-harness.js';
import {
  account,
  arrivalEmail,
  createArrival,
  mockImap,
  sdkAnswers,
  systemOneConfig,
  systemOneMock,
} from '../../test-support/mail-arrival-harness.js';
import type ImapService from '../imap.service.js';
import type { ArrivalEmail } from './index.js';
import { MailArrival } from './index.js';

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

async function handleMany(arrival: MailArrival, count: number, prefix: string): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    await arrival.handle(arrivalEmail(`${prefix}-${n}`));
  }
}

const filedAsReceipt = { kind: 'apply', destinationMailbox: 'Receipts', flag: true };

/** Mail from some automated senders carries no Message-ID header. */
function withoutMessageId(email: ArrivalEmail): ArrivalEmail {
  return { ...email, meta: { ...email.meta, messageId: undefined } };
}

const work = { ...account, name: 'work', email: 'work@example.com', username: 'work@example.com' };

async function twoAccountArrival(): Promise<MailArrival> {
  const arrival = await MailArrival.tryCreate({
    config: systemOneConfig({ sourceFolders: ['INBOX', 'Support'] }),
    imap: mockImap() as unknown as ImapService,
    apiKey: 'test-key',
    accounts: [account, work],
  });
  if (!arrival) throw new Error('expected MailArrival instance');
  return arrival;
}

function answersWith(overrides: Partial<SdkReply['answers']>): SdkReply {
  const reply = sdkAnswers();
  return { ...reply, answers: { ...reply.answers, ...overrides } as SdkReply['answers'] };
}

describe('MailArrival.handle repeat notices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemOneMock.mockResolvedValue(sdkAnswers());
  });

  it('should not classify a message again once it was filed', async () => {
    const arrival = await createArrival(mockImap());
    await arrival.handle(arrivalEmail('10'));
    expect(await arrival.handle(arrivalEmail('10'))).toEqual({
      kind: 'noop',
      reason: 'already_seen',
    });
  });

  it('should classify a message once when two notices for it overlap', async () => {
    const arrival = await createArrival(mockImap());
    const actions = await Promise.all([
      arrival.handle(arrivalEmail('10')),
      arrival.handle(arrivalEmail('10')),
    ]);
    expect(actions).toEqual([filedAsReceipt, { kind: 'noop', reason: 'already_seen' }]);
  });

  it('should classify a message again after System One failed on it', async () => {
    systemOneMock.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const arrival = await createArrival(mockImap());
    await arrival.handle(arrivalEmail('10'));
    expect(await arrival.handle(arrivalEmail('10'))).toEqual(filedAsReceipt);
  });

  it('should classify a message again after its sender checks could not be read', async () => {
    const imap = mockImap();
    imap.getEmailSecurity.mockRejectedValueOnce(new Error('Connection not available'));
    const arrival = await createArrival(imap);
    await arrival.handle(arrivalEmail('10'));
    expect(await arrival.handle(arrivalEmail('10'))).toEqual(filedAsReceipt);
  });

  it.each([
    ['injection_filter', { contains_prompt_injection: { type: 'noul', noul: 0.9 } }, {}],
    ['spam_uncertain', { requests_credentials: { type: 'noul', noul: 1 } }, {}],
    [
      'no_folder_fit',
      {
        folder_fit_receipts: { type: 'noul', noul: 0.1 },
        importance: { type: 'score', score: 1, confidence: 0.8 },
      },
      {},
    ],
    [
      'auto_move_off',
      { importance: { type: 'score', score: 1, confidence: 0.8 } },
      { autoMove: false },
    ],
  ] as const)(
    'should not classify a message again after a deliberate %s noop',
    async (reason, answers, config) => {
      systemOneMock.mockResolvedValue(answersWith(answers));
      const arrival = await createArrival(mockImap(), config);
      const actions = [
        await arrival.handle(arrivalEmail('10')),
        await arrival.handle(arrivalEmail('10')),
      ];
      expect(actions).toEqual([
        { kind: 'noop', reason },
        { kind: 'noop', reason: 'already_seen' },
      ]);
    },
  );

  it('should classify a message without a Message-ID once per account and mailbox', async () => {
    const arrival = await twoAccountArrival();
    const actions = [
      await arrival.handle(withoutMessageId(arrivalEmail('10', 'personal'))),
      await arrival.handle(withoutMessageId(arrivalEmail('10', 'work'))),
      await arrival.handle({
        ...withoutMessageId(arrivalEmail('10', 'personal')),
        mailbox: 'Support',
      }),
    ];
    expect(actions).toEqual([filedAsReceipt, filedAsReceipt, filedAsReceipt]);
  });

  // Mail sent to two of the user's addresses is two arrivals, one in each account.
  it('should classify the same Message-ID once for each account that received it', async () => {
    const arrival = await twoAccountArrival();
    const actions = [
      await arrival.handle(arrivalEmail('10', 'personal')),
      await arrival.handle(arrivalEmail('10', 'work')),
    ];
    expect(actions).toEqual([filedAsReceipt, filedAsReceipt]);
  });

  it('should recognise a message that reappears under a new UID by its Message-ID', async () => {
    const arrival = await createArrival(mockImap());
    await arrival.handle(arrivalEmail('10'));
    const renumbered = arrivalEmail('11');
    renumbered.meta.messageId = '<10@example.com>';
    expect(await arrival.handle(renumbered)).toEqual({ kind: 'noop', reason: 'already_seen' });
  });

  it('should recognise a message moved to another folder of the same account by its Message-ID', async () => {
    const arrival = await twoAccountArrival();
    await arrival.handle(arrivalEmail('10'));
    const moved = { ...arrivalEmail('11'), mailbox: 'Support' };
    moved.meta.messageId = '<10@example.com>';
    expect(await arrival.handle(moved)).toEqual({ kind: 'noop', reason: 'already_seen' });
  });

  it('should still remember a message after 4999 newer ones', async () => {
    const arrival = await createArrival(mockImap());
    await arrival.handle(arrivalEmail('first'));
    await handleMany(arrival, 4999, 'newer');
    expect(await arrival.handle(arrivalEmail('first'))).toEqual({
      kind: 'noop',
      reason: 'already_seen',
    });
  });

  it('should forget the oldest message once 5000 newer ones were filed', async () => {
    const arrival = await createArrival(mockImap());
    await arrival.handle(arrivalEmail('first'));
    await handleMany(arrival, 5000, 'newer');
    expect(await arrival.handle(arrivalEmail('first'))).toEqual(filedAsReceipt);
  });
});
