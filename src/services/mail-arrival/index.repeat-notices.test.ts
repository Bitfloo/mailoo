import type { SdkReply } from '../../test-support/mail-arrival-harness.js';
import {
  arrivalEmail,
  createArrival,
  mockImap,
  sdkAnswers,
  systemOneMock,
} from '../../test-support/mail-arrival-harness.js';
import type { MailArrival } from './index.js';

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
    ['injection_filter', { contains_prompt_injection: { type: 'noul', noul: 0.9 } }],
    ['spam_uncertain', { requests_credentials: { type: 'noul', noul: 1 } }],
    [
      'no_folder_fit',
      {
        folder_fit_receipts: { type: 'noul', noul: 0.1 },
        importance: { type: 'score', score: 1, confidence: 0.8 },
      },
    ],
  ] as const)(
    'should not classify a message again after a deliberate %s noop',
    async (reason, answers) => {
      systemOneMock.mockResolvedValue(answersWith(answers));
      const arrival = await createArrival(mockImap());
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
