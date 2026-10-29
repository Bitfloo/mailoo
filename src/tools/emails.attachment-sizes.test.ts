import ImapService from '../services/imap.service.js';
import { attachmentNode, mixedStructure } from '../test-support/imap-bodystructure.js';
import {
  createMockConnectionManager,
  createMockImapClient,
  downloadReturnsPartName,
  fetchOneByUid,
} from '../test-support/imap-client-fake.js';
import registerEmailsTools from './emails.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

type GetEmailHandler = (args: {
  account: string;
  emailId: string;
  mailbox: string;
  format: 'text';
  markRead: boolean;
}) => Promise<{ content: { text: string }[] }>;

/** The 📎 line get_email prints, from a real ImapService over a client that serves these parts. */
async function attachmentLine(...nodes: object[]): Promise<string | undefined> {
  const client = createMockImapClient();
  fetchOneByUid(client, {
    uid: 9,
    envelope: { subject: 'Sizes', from: [{ address: 'sender@example.com' }] },
    flags: new Set<string>(),
    bodyStructure: mixedStructure(...nodes),
  });
  downloadReturnsPartName(client);
  const service = new ImapService(createMockConnectionManager(client));

  let getEmail: GetEmailHandler | undefined;
  const server = {
    registerTool: (name: string, _config: unknown, fn: GetEmailHandler) => {
      if (name === 'get_email') getEmail = fn;
    },
  };
  registerEmailsTools(server as never, service, false);
  if (!getEmail) throw new Error('get_email handler was not registered');

  const result = await getEmail({
    account: 'test',
    emailId: '9',
    mailbox: 'INBOX',
    format: 'text',
    markRead: false,
  });
  return result.content[0]?.text.split('\n').find((line) => line.startsWith('📎'));
}

describe('get_email attachment sizes', () => {
  // GreenMail reports 273684 for the 200000-byte file nodemailer sent; the true size is 195.3KB.
  it('should show the decoded size with a tilde for base64 and the reported size for the rest', async () => {
    const line = await attachmentLine(
      attachmentNode('2', 'próbka-ąę.bin', { type: 'application/octet-stream', size: 273_684 }),
      attachmentNode('3', 'notes.txt', { encoding: '7bit', size: 34 }),
      attachmentNode('4', 'quoted.txt', { encoding: 'quoted-printable', size: 2048 }),
    );

    expect(line).toBe(
      '📎 Attachments: próbka-ąę.bin (application/octet-stream, ~195.3KB), notes.txt (text/plain, 34B), quoted.txt (text/plain, 2.0KB)',
    );
  });

  // 40 encoded bytes -> 29B, 8000000 -> 5.6MB: the tilde must not belong to one unit branch.
  it.each([
    [40, '~29B'],
    [8_000_000, '~5.6MB'],
  ])(
    'should put the tilde before an estimated size of %i encoded bytes: %s',
    async (size, shown) => {
      const line = await attachmentLine(attachmentNode('2', 'a.bin', { size }));

      expect(line).toBe(`📎 Attachments: a.bin (text/plain, ${shown})`);
    },
  );
});
