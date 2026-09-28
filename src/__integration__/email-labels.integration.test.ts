import fs from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import createServer from '../server.js';
import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

// add_label logs the refusal. Keep that log under reports/ (gitignored).
vi.stubEnv('XDG_DATA_HOME', `${process.cwd()}/reports/xdg-data`);

interface TextToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function isTextToolResult(result: unknown): result is TextToolResult {
  if (typeof result !== 'object' || result === null || !('content' in result)) return false;
  return Array.isArray(result.content);
}

async function fetchFlags(services: TestServices, emailId: string): Promise<string[]> {
  const client = await services.connections.getImapClient(TEST_ACCOUNT_NAME);
  const lock = await client.getMailboxLock('INBOX');
  try {
    const msg = await client.fetchOne(emailId, { flags: true }, { uid: true });
    if (!msg || typeof msg !== 'object') {
      throw new Error(`FETCH FLAGS returned nothing for UID ${emailId}`);
    }
    const flags = 'flags' in msg ? msg.flags : undefined;
    return [...(flags ?? [])].map(String);
  } finally {
    lock.release();
  }
}

describe('Email Label Operations', () => {
  let services: TestServices;

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    await seedEmail({ subject: 'Label test email' });
    await waitForDelivery();
  });

  afterAll(async () => {
    await services.connections.closeAll();
    vi.unstubAllEnvs();
    await fs.rm(`${process.cwd()}/reports/xdg-data`, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // list_labels
  // ---------------------------------------------------------------------------

  describe('listLabels', () => {
    it('should list available labels', async () => {
      const labels = await services.imapService.listLabels(TEST_ACCOUNT_NAME);
      expect(labels).toBeInstanceOf(Array);
    });
  });

  // ---------------------------------------------------------------------------
  // create_label + delete_label
  // ---------------------------------------------------------------------------

  describe('createLabel / deleteLabel', () => {
    it('should handle IMAP keyword lifecycle', async () => {
      // For standard IMAP, createLabel is a no-op (labels are keywords auto-created on use)
      await services.imapService.createLabel(TEST_ACCOUNT_NAME, 'TestLabel');

      // deleteLabel throws for standard IMAP keywords (cannot be deleted server-wide)
      await expect(
        services.imapService.deleteLabel(TEST_ACCOUNT_NAME, 'TestLabel'),
      ).rejects.toThrow(/cannot be deleted/i);
    });
  });

  // ---------------------------------------------------------------------------
  // add_label + remove_label
  // ---------------------------------------------------------------------------

  describe('addLabel / removeLabel', () => {
    it('should add and remove a label from an email', async () => {
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Label test email',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);
      const emailId = list.items[0].id;

      // Add label
      await services.imapService.addLabel(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'MyTag');

      // Verify label is present
      const flagsAfterAdd = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flagsAfterAdd.labels).toContain('MyTag');

      // Remove label
      await services.imapService.removeLabel(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'MyTag');

      // Verify label is removed
      const flagsAfterRemove = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flagsAfterRemove.labels).not.toContain('MyTag');
    });

    it('should add and remove a label that contains a quote', async () => {
      // GreenMail stores a non-atom keyword; the oracle is that the quote round-trips escaped.
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'Label test email',
      });
      const emailId = list.items[0].id;

      await services.imapService.addLabel(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'Bad"Tag');

      const flagsAfterAdd = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flagsAfterAdd.labels).toContain('Bad"Tag');

      await services.imapService.removeLabel(TEST_ACCOUNT_NAME, emailId, 'INBOX', 'Bad"Tag');

      const flagsAfterRemove = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId);
      expect(flagsAfterRemove.labels).not.toContain('Bad"Tag');
    });

    it('should return isError and leave FLAGS without \\Deleted when add_label is a system flag', async () => {
      await seedEmail({ subject: 'System flag label refusal' });
      await waitForDelivery();
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
        subject: 'System flag label refusal',
      });
      expect(list.items.length).toBeGreaterThanOrEqual(1);
      const emailId = list.items[0].id;

      const { registerLabelWriteTools } = await import('../tools/label.tool.js');
      const { default: audit } = await import('../safety/audit.js');
      expect(audit.AUDIT_LOG_PATH.startsWith(process.cwd())).toBe(true);

      const server = createServer();
      registerLabelWriteTools(server, services.imapService);
      const mcp = new Client({ name: 'mailoo-labels', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
      try {
        const result = await mcp.callTool({
          name: 'add_label',
          arguments: {
            account: TEST_ACCOUNT_NAME,
            emailId,
            mailbox: 'INBOX',
            label: '\\Deleted',
          },
        });
        if (!isTextToolResult(result)) throw new Error('tool result has no text content');
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('System flags are not labels; use mark_email.');
      } finally {
        await Promise.allSettled([mcp.close(), server.close()]);
      }

      const flags = await fetchFlags(services, emailId);
      expect(flags.some((flag) => flag.toLowerCase() === '\\deleted')).toBe(false);
    });
  });
});
