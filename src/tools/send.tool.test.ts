import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import ConnectionManager from '../connections/manager.js';
import RateLimiter from '../safety/rate-limiter.js';
import createServer from '../server.js';
import ImapService from '../services/imap.service.js';
import SmtpService from '../services/smtp.service.js';
import { readAuditEntries } from '../test-support/audit-home.js';
import type { AccountConfig } from '../types/index.js';
import registerSendTools from './send.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

const h = vi.hoisted(() => ({ sendError: null as Error | null }));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

// verify() passes; sendMail() then logs in on its own connection and the server refuses it.
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      verify: async () => true,
      sendMail: async () => {
        if (h.sendError) throw h.sendError;
        return { messageId: '<sent@example.com>' };
      },
      close: vi.fn(),
    }),
  },
}));

const account: AccountConfig = {
  name: 'test',
  email: 'test@example.com',
  username: 'test@example.com',
  password: 'S3cret-Pa55word!',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

/** nodemailer's EAUTH shape: the server line in the message and in `response`. */
function eauth(reply: string): Error {
  return Object.assign(new Error(`Invalid login: ${reply}`), {
    code: 'EAUTH',
    response: reply,
    responseCode: 535,
    command: 'AUTH PLAIN',
  });
}

/** The text send_email returns, as the client receives it. */
async function sendEmailText(smtp: SmtpService): Promise<string> {
  const server = createServer();
  registerSendTools(server, smtp);
  const client = new Client({ name: 'mailoo-send', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const { content } = await client.callTool({
      name: 'send_email',
      arguments: {
        account: 'test',
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      },
    });
    if (!Array.isArray(content)) throw new Error('send_email returned no content');
    const [block] = content as { text?: unknown }[];
    if (typeof block?.text !== 'string') throw new Error('send_email returned no text');
    return block.text;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

afterAll(async () => {
  await auditHome.restore();
});

describe('send_email on a refused SMTP login', () => {
  it('should return and audit the error with the password the 535 reply quotes redacted', async () => {
    h.sendError = eauth('535 5.7.8 S3cret-Pa55word! rejected');
    const manager = new ConnectionManager([account]);
    const smtp = new SmtpService(manager, new RateLimiter(), new ImapService(manager));
    const text = await sendEmailText(smtp);
    expect({ text, entry: (await readAuditEntries(auditHome)).at(-1) }).toEqual({
      text: 'Failed to send email: Invalid login: 535 5.7.8 [redacted] rejected',
      entry: {
        ts: expect.any(String),
        tool: 'send_email',
        account: 'test',
        params: { to: ['recipient@example.com'], subject: 'Hello' },
        result: 'error',
        error: 'Invalid login: 535 5.7.8 [redacted] rejected',
      },
    });
  });
});
