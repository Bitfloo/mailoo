import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import createServer from '../server.js';
import { applyBodyFormatWithDefaultCap, DEFAULT_BODY_MAX_LENGTH } from '../utils/email-body.js';
import registerBulkTools from './bulk.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerFolderTools from './folders.tool.js';
import registerManageTools from './manage.tool.js';
import {
  normalizeNumericIds,
  normalizeStringIds,
  resolveDraftId,
  resolveEmailId,
  resolveHasAttachment,
} from './schema-helpers.js';
import registerSendTools from './send.tool.js';
import { registerSieveWriteTools } from './sieve.tool.js';
import registerThreadTools from './thread.tool.js';

// send_email and send_draft append to audit.log, which would otherwise land in the user's data directory.
const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

interface ToolResponse {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: { ok: boolean; summary: string; dryRun?: boolean };
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResponse> {
  const client = new Client({ name: 'mailoo-schema-helpers-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return (await client.callTool({ name, arguments: args })) as unknown as ToolResponse;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe('schema-helpers parameter normalization', () => {
  it('resolves emailId from emailId, id, or email_id as string or number', () => {
    expect(resolveEmailId({ emailId: '42' })).toBe('42');
    expect(resolveEmailId({ emailId: 42 })).toBe('42');
    expect(resolveEmailId({ id: 42 })).toBe('42');
    expect(resolveEmailId({ id: '42' })).toBe('42');
    expect(resolveEmailId({ email_id: '42' })).toBe('42');
    expect(resolveEmailId({ email_id: 42 })).toBe('42');
    expect(() => resolveEmailId({})).toThrow(/Email ID is required/);
  });

  it('normalizes string and numeric ID arrays', () => {
    expect(normalizeStringIds([42, '43'])).toEqual(['42', '43']);
    expect(normalizeNumericIds(['42', 43])).toEqual([42, 43]);
    expect(() => normalizeNumericIds(['abc'])).toThrow(/Invalid email ID/);
  });

  it('resolves draft ID from id, emailId, or email_id as number or numeric string', () => {
    expect(resolveDraftId({ id: 42 })).toBe(42);
    expect(resolveDraftId({ id: '42' })).toBe(42);
    expect(resolveDraftId({ emailId: '42' })).toBe(42);
    expect(resolveDraftId({ email_id: 42 })).toBe(42);
    expect(() => resolveDraftId({})).toThrow(/Draft ID is required/);
  });

  it('resolves attachment filter from hasAttachment or has_attachment', () => {
    expect(resolveHasAttachment({ hasAttachment: true })).toBe(true);
    expect(resolveHasAttachment({ has_attachment: false })).toBe(false);
    expect(resolveHasAttachment({})).toBeUndefined();
  });
});

describe('context window protection (default 20,000 char cap)', () => {
  it('truncates bodies exceeding DEFAULT_BODY_MAX_LENGTH when maxLength is omitted', () => {
    const hugeText = 'A'.repeat(DEFAULT_BODY_MAX_LENGTH + 500);
    const result = applyBodyFormatWithDefaultCap(hugeText, undefined, 'text', undefined);
    expect(result).toContain('[Truncated at 20000 characters');
    expect(result.length).toBeLessThan(DEFAULT_BODY_MAX_LENGTH + 150);
  });

  it('truncates get_email and get_thread bodies by default and accepts id/email_id aliases', async () => {
    const server = createServer();
    const hugeBody = 'Hello '.repeat(5000);
    const mockImap = {
      getEmail: vi.fn().mockResolvedValue({
        id: '42',
        messageId: '<msg-42@example.com>',
        subject: 'Long message',
        from: { address: 'alice@example.com' },
        to: [{ address: 'bob@example.com' }],
        date: '2026-10-18T10:00:00Z',
        bodyText: hugeBody,
        seen: true,
        flagged: false,
        answered: false,
        labels: [],
        hasAttachments: false,
        attachments: [],
      }),
      getThread: vi.fn().mockResolvedValue({
        threadId: '<msg-42@example.com>',
        subject: 'Long thread',
        participants: [{ address: 'alice@example.com' }],
        messageCount: 1,
        lastMessageDate: '2026-10-18T10:00:00Z',
        messages: [
          {
            id: '42',
            messageId: '<msg-42@example.com>',
            subject: 'Long message',
            from: { address: 'alice@example.com' },
            to: [{ address: 'bob@example.com' }],
            date: '2026-10-18T10:00:00Z',
            bodyText: hugeBody,
            seen: true,
            flagged: false,
            answered: false,
            labels: [],
            hasAttachments: false,
            attachments: [],
          },
        ],
      }),
    };

    registerEmailsTools(server, mockImap as never, false);
    registerThreadTools(server, mockImap as never);

    const emailRes = await callTool(server, 'get_email', { id: 42 });
    expect(emailRes.isError).toBeUndefined();
    expect(emailRes.content[0]?.text).toContain('[Truncated at 20000 characters');
    expect(emailRes.structuredContent?.ok).toBe(true);
    expect(mockImap.getEmail).toHaveBeenCalledWith('', '42', 'INBOX');

    const threadRes = await callTool(server, 'get_thread', { message_id: '<msg-42@example.com>' });
    expect(threadRes.isError).toBeUndefined();
    expect(threadRes.content[0]?.text).toContain('[Truncated at 20000 characters');
    expect(threadRes.structuredContent?.ok).toBe(true);
    expect(mockImap.getThread).toHaveBeenCalledWith('', '<msg-42@example.com>', 'INBOX');
  });

  it('accepts string draft ID in send_draft', async () => {
    const server = createServer();
    const mockSmtp = {
      sendDraft: vi.fn().mockResolvedValue({ messageId: '<sent-42@example.com>' }),
    };
    registerDraftTools(server, {} as never, mockSmtp as never);

    const res = await callTool(server, 'send_draft', { id: '42' });
    expect(res.isError).toBeUndefined();
    expect(mockSmtp.sendDraft).toHaveBeenCalledWith('', 42, undefined);
  });
});

describe('dryRun mode for high-risk operations', () => {
  // send_draft sends mail like send_email; a dryRun flag it did not declare was dropped and the draft went out.
  it('previews send_draft without sending the draft', async () => {
    const server = createServer();
    const mockSmtp = { resolveAccountName: vi.fn().mockReturnValue('work'), sendDraft: vi.fn() };
    registerDraftTools(server, {} as never, mockSmtp as never);

    const res = await callTool(server, 'send_draft', { id: 42, dryRun: true });

    expect({
      text: res.content[0]?.text,
      structured: res.structuredContent,
      sends: mockSmtp.sendDraft.mock.calls.length,
    }).toEqual({
      text: '[DRY RUN] Would send draft 42 from the Drafts folder on account "work" and remove it from Drafts.',
      structured: expect.objectContaining({ ok: true, dryRun: true }),
      sends: 0,
    });
  });

  it('previews send_email, reply_email, forward_email, delete_email, bulk_action, delete_mailbox, sieve_put_script, and sieve_delete_script without mutating server state', async () => {
    const server = createServer();
    const mockSmtp = {
      resolveAccountName: vi.fn().mockReturnValue('work'),
      sendEmail: vi.fn(),
    };
    const mockImap = {
      resolveAccountName: vi.fn().mockReturnValue('work'),
      getEmail: vi.fn().mockResolvedValue({
        id: '42',
        subject: 'Original Subject',
        from: { address: 'sender@example.com' },
        to: [{ address: 'me@example.com' }],
        date: '2026-10-18T10:00:00Z',
        bodyText: 'Original body',
        flags: [],
        hasAttachments: false,
        attachments: [],
      }),
      deleteEmail: vi.fn(),
      bulkDelete: vi.fn(),
      deleteMailbox: vi.fn(),
    };
    const mockConnections = {
      getAccount: vi.fn().mockReturnValue({ name: 'work', email: 'me@example.com' }),
    };
    const mockSieve = {
      putScript: vi.fn(),
      deleteScript: vi.fn(),
    };

    registerSendTools(server, mockSmtp as never);
    registerManageTools(server, mockImap as never);
    registerBulkTools(server, mockImap as never);
    registerFolderTools(server, mockImap as never);
    registerSieveWriteTools(server, mockConnections as never, mockSieve as never);

    const sendRes = await callTool(server, 'send_email', {
      to: ['bob@example.com'],
      subject: 'Hello',
      body: 'Test',
      dryRun: true,
    });
    expect(sendRes.content[0]?.text).toContain('[DRY RUN]');
    expect(sendRes.structuredContent).toMatchObject({ ok: true, dryRun: true });
    expect(mockSmtp.sendEmail).not.toHaveBeenCalled();

    const replyRes = await callTool(server, 'reply_email', {
      id: 42,
      body: 'Reply text',
      dryRun: true,
    });
    expect(replyRes.content[0]?.text).toContain('[DRY RUN]');
    expect(replyRes.structuredContent).toMatchObject({ ok: true, dryRun: true });
    expect(mockSmtp.sendEmail).not.toHaveBeenCalled();

    const forwardRes = await callTool(server, 'forward_email', {
      email_id: '42',
      to: ['carol@example.com'],
      dryRun: true,
    });
    expect(forwardRes.content[0]?.text).toContain('[DRY RUN]');
    expect(forwardRes.structuredContent).toMatchObject({ ok: true, dryRun: true });
    expect(mockSmtp.sendEmail).not.toHaveBeenCalled();

    const deleteRes = await callTool(server, 'delete_email', {
      id: 42,
      permanent: true,
      dryRun: true,
    });
    expect(deleteRes.content[0]?.text).toContain('[DRY RUN]');
    expect(deleteRes.structuredContent).toMatchObject({ ok: true, dryRun: true });
    expect(mockImap.deleteEmail).not.toHaveBeenCalled();

    const bulkRes = await callTool(server, 'bulk_action', {
      ids: [42, 43],
      action: 'delete',
      dryRun: true,
    });
    expect(bulkRes.content[0]?.text).toContain('[DRY RUN]');
    expect(bulkRes.structuredContent).toMatchObject({ ok: true, dryRun: true });
    expect(mockImap.bulkDelete).not.toHaveBeenCalled();

    const folderRes = await callTool(server, 'delete_mailbox', {
      path: 'OldArchive',
      confirm: true,
      dryRun: true,
    });
    expect(folderRes.content[0]?.text).toContain('[DRY RUN]');
    expect(folderRes.structuredContent).toMatchObject({ ok: true, dryRun: true });
    expect(mockImap.deleteMailbox).not.toHaveBeenCalled();

    const sievePutRes = await callTool(server, 'sieve_put_script', {
      name: 'vacation',
      content: 'require ["fileinto"];',
      dryRun: true,
    });
    expect(sievePutRes.content[0]?.text).toContain('[DRY RUN]');
    expect(sievePutRes.structuredContent).toMatchObject({ ok: true, dryRun: true });
    expect(mockSieve.putScript).not.toHaveBeenCalled();

    const sieveDelRes = await callTool(server, 'sieve_delete_script', {
      name: 'vacation',
      dryRun: true,
    });
    expect(sieveDelRes.content[0]?.text).toContain('[DRY RUN]');
    expect(sieveDelRes.structuredContent).toMatchObject({ ok: true, dryRun: true });
    expect(mockSieve.deleteScript).not.toHaveBeenCalled();
  });
});
