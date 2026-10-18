import type { SdkReply } from '../../test-support/mail-arrival-harness.js';
import {
  arrivalEmail,
  createArrival,
  mockImap,
  sdkAnswers,
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

const API_ERROR = { kind: 'noop', reason: 'api_error' };

// Every answer the policy reads besides folder fit; a reply without one cannot be decided.
const REQUIRED_ANSWERS = [
  'contains_prompt_injection',
  'requests_credentials',
  'offers_unexpected_reward',
  'sender_identity_mismatch',
  'is_critical',
  'importance',
];

function replyWithout(answer: string): SdkReply {
  const reply = sdkAnswers();
  reply.answers = Object.fromEntries(Object.entries(reply.answers).filter(([id]) => id !== answer));
  return reply;
}

function replyWith(answers: Record<string, unknown>): SdkReply {
  const reply = sdkAnswers();
  return { ...reply, answers: { ...reply.answers, ...answers } as SdkReply['answers'] };
}

describe('MailArrival.handle malformed System One reply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(REQUIRED_ANSWERS)(
    'should treat a reply as an api_error when its %s answer is missing',
    async (answer) => {
      systemOneMock.mockResolvedValue(replyWithout(answer));
      const arrival = await createArrival(mockImap());
      expect(await arrival.handle(arrivalEmail('10'))).toEqual(API_ERROR);
    },
  );

  it('should treat a reply as an api_error when a noul is not a finite number', async () => {
    systemOneMock.mockResolvedValue(
      replyWith({ contains_prompt_injection: { type: 'noul', noul: Number.NaN } }),
    );
    const arrival = await createArrival(mockImap());
    expect(await arrival.handle(arrivalEmail('10'))).toEqual(API_ERROR);
  });

  it('should treat a reply as an api_error when the importance score has no confidence', async () => {
    systemOneMock.mockResolvedValue(replyWith({ importance: { type: 'score', score: 3.2 } }));
    const arrival = await createArrival(mockImap());
    expect(await arrival.handle(arrivalEmail('10'))).toEqual(API_ERROR);
  });

  it('should treat a reply as an api_error when the importance score is not finite', async () => {
    systemOneMock.mockResolvedValue(
      replyWith({
        importance: { type: 'score', score: Number.POSITIVE_INFINITY, confidence: 0.8 },
      }),
    );
    const arrival = await createArrival(mockImap());
    expect(await arrival.handle(arrivalEmail('10'))).toEqual(API_ERROR);
  });

  it('should classify a message again when its first reply was malformed', async () => {
    systemOneMock
      .mockResolvedValueOnce(replyWithout('importance'))
      .mockResolvedValueOnce(sdkAnswers());
    const arrival = await createArrival(mockImap());
    await arrival.handle(arrivalEmail('10'));
    expect(await arrival.handle(arrivalEmail('10'))).toEqual({
      kind: 'apply',
      destinationMailbox: 'Receipts',
      flag: true,
    });
  });
});
