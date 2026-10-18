import { mcpLog } from '../logging.js';
import type RateLimiter from '../safety/rate-limiter.js';
import {
  createMockConnectionManager,
  createMockImapService,
  createMockRateLimiter,
  createMockTransport,
} from '../test-support/smtp-harness.js';
import SmtpService from './smtp.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let imap: ReturnType<typeof createMockImapService>;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    imap = createMockImapService();
    service = new SmtpService(connections, rateLimiter, imap);
  });

  describe('sendDraft', () => {
    /** Shape ImapService.fetchDraft returns for a plain-text draft in Drafts. */
    function draftInDrafts() {
      return {
        mailbox: 'Drafts',
        email: {
          id: '42',
          subject: 'Contract follow-up',
          from: { name: 'Test User', address: 'test@example.com' },
          to: [{ address: 'recipient@example.com' }],
          date: '2026-10-01T08:00:00.000Z',
          seen: true,
          flagged: false,
          answered: false,
          hasAttachments: false,
          labels: [],
          bodyText: 'Please find the signed copy attached later today.',
          attachments: [],
          headers: {},
        },
      };
    }

    beforeEach(() => {
      vi.mocked(imap.fetchDraft).mockResolvedValue(draftInDrafts() as never);
    });

    it('should report the mail as sent with the draft kept when removing it fails', async () => {
      vi.mocked(imap.deleteDraft).mockRejectedValue(new Error('Drafts lock timed out'));

      const result = await service.sendDraft('test', 42);

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
        savedToSent: true,
        draftDeleted: false,
      });
    });

    it('should log a warning with the reason when removing the draft fails', async () => {
      vi.mocked(imap.deleteDraft).mockRejectedValue(new Error('Drafts lock timed out'));

      await service.sendDraft('test', 42);

      expect(mcpLog).toHaveBeenCalledWith(
        'warning',
        'smtp',
        'Draft 42 was sent but not removed from Drafts: Drafts lock timed out',
      );
    });

    it('should remove the draft from the Drafts folder the server reported', async () => {
      // The caller names no folder; fetchDraft found Gmail's special-use Drafts folder.
      vi.mocked(imap.fetchDraft).mockResolvedValue({
        ...draftInDrafts(),
        mailbox: '[Gmail]/Drafts',
      } as never);
      vi.mocked(imap.deleteDraft).mockResolvedValue(undefined);

      await service.sendDraft('test', 42);

      expect(vi.mocked(imap.deleteDraft).mock.calls).toEqual([['test', 42, '[Gmail]/Drafts']]);
    });

    it('should report the draft as removed when the delete succeeds', async () => {
      vi.mocked(imap.deleteDraft).mockResolvedValue(undefined);

      const result = await service.sendDraft('test', 42);

      expect(result.draftDeleted).toBe(true);
    });
  });
});
