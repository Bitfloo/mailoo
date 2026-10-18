import type ImapService from '../services/imap.service.js';
import type SmtpService from '../services/smtp.service.js';
import { readAuditEntries } from '../test-support/audit-home.js';
import type { SendResult } from '../types/index.js';
import registerDraftTools from './drafts.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

type Handler = (args: {
  account: string;
  id: number;
  mailbox?: string;
}) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;

/** The send_draft handler over an SmtpService whose sendDraft is `sendDraft`. */
function sendDraftTool(sendDraft: SmtpService['sendDraft']): Handler {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  registerDraftTools(server as never, {} as ImapService, { sendDraft } as unknown as SmtpService);
  const handler = handlers.get('send_draft');
  if (!handler) throw new Error('send_draft handler was not registered');
  return handler;
}

async function sendDraftText(result: SendResult): Promise<string> {
  const response = await sendDraftTool(vi.fn().mockResolvedValue(result))({
    account: 'work',
    id: 42,
  });
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

  it('should record the sent draft in the audit log', async () => {
    await sendDraftText({
      messageId: '<draft-42@example.com>',
      status: 'sent',
      savedToSent: true,
      draftDeleted: true,
    });

    expect((await readAuditEntries(auditHome)).at(-1)).toEqual({
      ts: expect.any(String),
      tool: 'send_draft',
      account: 'work',
      params: { id: 42 },
      result: 'ok',
    });
  });

  it('should pass the mailbox to sendDraft', async () => {
    const sendDraft = vi.fn().mockResolvedValue({
      messageId: '<draft-42@example.com>',
      status: 'sent',
      savedToSent: true,
      draftDeleted: true,
    });

    await sendDraftTool(sendDraft)({ account: 'work', id: 42, mailbox: 'Drafts' });

    expect(sendDraft.mock.calls).toEqual([['work', 42, 'Drafts']]);
  });

  it('should record the mailbox in the audit entry of a sent draft', async () => {
    await sendDraftTool(
      vi.fn().mockResolvedValue({
        messageId: '<draft-42@example.com>',
        status: 'sent',
        savedToSent: true,
        draftDeleted: true,
      }),
    )({ account: 'work', id: 42, mailbox: 'Drafts' });

    expect((await readAuditEntries(auditHome)).at(-1)?.params).toEqual({
      id: 42,
      mailbox: 'Drafts',
    });
  });

  it('should return isError with the reason when sending fails', async () => {
    const response = await sendDraftTool(vi.fn().mockRejectedValue(new Error('smtp down')))({
      account: 'work',
      id: 42,
      mailbox: 'Drafts',
    });

    expect(response).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Failed to send draft: smtp down' }],
    });
  });

  it('should audit a failed send as an error with the reason and the mailbox', async () => {
    await sendDraftTool(vi.fn().mockRejectedValue(new Error('smtp down')))({
      account: 'work',
      id: 42,
      mailbox: 'Drafts',
    });

    expect((await readAuditEntries(auditHome)).at(-1)).toEqual({
      ts: expect.any(String),
      tool: 'send_draft',
      account: 'work',
      params: { id: 42, mailbox: 'Drafts' },
      result: 'error',
      error: 'smtp down',
    });
  });
});
