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
});
