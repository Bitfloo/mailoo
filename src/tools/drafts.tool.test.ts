import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';
import type { SendResult } from '../types/index.js';
import registerDraftTools from './drafts.tool.js';

const { log } = vi.hoisted(() => ({ log: vi.fn() }));
// The real audit log writes under the user's data directory.
vi.mock('../safety/audit.js', () => ({ default: { log } }));

type Handler = (args: {
  account: string;
  id: number;
  mailbox?: string;
}) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;

async function sendDraftText(result: SendResult): Promise<string> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  const smtp = { sendDraft: vi.fn().mockResolvedValue(result) };
  registerDraftTools(server as never, {} as ImapService, smtp as unknown as SmtpService);
  const handler = handlers.get('send_draft');
  if (!handler) throw new Error('send_draft handler was not registered');
  const response = await handler({ account: 'work', id: 42 });
  return response.content[0].text;
}

describe('send_draft tool', () => {
  it('should say the draft is still in Drafts when it was sent but not removed', async () => {
    const text = await sendDraftText({
      messageId: '<draft-42@example.com>',
      status: 'sent',
      savedToSent: true,
      draftDeleted: false,
    });

    expect(text).toBe(
      '✅ Draft sent (Message-ID: <draft-42@example.com>). Removing the draft failed, so it is ' +
        'still in Drafts: delete it instead of sending it again.',
    );
  });

  it('should say the draft was removed when the delete succeeded', async () => {
    const text = await sendDraftText({
      messageId: '<draft-42@example.com>',
      status: 'sent',
      savedToSent: true,
      draftDeleted: true,
    });

    expect(text).toBe(
      '✅ Draft sent (Message-ID: <draft-42@example.com>). Draft removed from folder.',
    );
  });
});
