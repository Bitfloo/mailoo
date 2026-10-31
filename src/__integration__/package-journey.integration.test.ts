import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import packMailoo, { PACKAGE_SETUP_MS } from '../test-support/packed-mailoo.js';
import { getGreenMailPorts, seedEmail, waitForDelivery } from './helpers/index.js';

let packed: Awaited<ReturnType<typeof packMailoo>>;

function config(): string {
  const { host, imapPort, smtpPort } = getGreenMailPorts();
  const accounts = ['test', 'bob'].map(
    (user) => `[[accounts]]
name = "${user}"
email = "${user}@example.test"
username = "${user}"
password = "${user}"
[accounts.imap]
host = "${host}"
port = ${imapPort}
tls = false
[accounts.smtp]
host = "${host}"
port = ${smtpPort}
tls = false
`,
  );
  return `[settings]
toolset = "core"
default_account = "test"
${accounts.join('\n')}`;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result;
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return JSON.stringify(result.structuredContent);
}

async function find(client: Client, subject: string, account = 'test', mailbox = 'INBOX') {
  const result = await call(client, 'list_emails', { account, mailbox, subject });
  const id = text(result).match(/\[(\d+)\]/)?.[1];
  expect(id, text(result)).toBeDefined();
  return id as string;
}

beforeAll(async () => {
  packed = await packMailoo();
}, PACKAGE_SETUP_MS);

describe('packed release over stdio MCP', () => {
  it('should run the documented CLI with production dependencies and an isolated config', async () => {
    await expect(access(path.join(packed.installed, 'src'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(access(path.join(packed.installed, 'node_modules', 'tsx'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const accounts = await packed.cli(config(), ['account', 'list']);
    expect(accounts.stdout).toContain('test@example.test');
    expect(accounts.stdout).toContain('bob@example.test');
    const probe = await packed.cli(config(), ['test']);
    expect(probe.stdout + probe.stderr).toContain('IMAP');
    expect(probe.stdout + probe.stderr).toContain('SMTP');
  });

  it('should discover, search and read a delivered message without marking it as read', async () => {
    const subject = 'Packed journey reading';
    await seedEmail({ subject, text: 'The meeting is at 14:00.' });
    await waitForDelivery(subject);
    const { client } = await packed.connect(config());
    expect(client.getServerVersion()?.version).toBe(packed.version);
    expect(text(await call(client, 'list_accounts'))).toContain('test@example.test');
    const search = await call(client, 'search_emails', { query: subject });
    expect(text(search)).toContain(subject);
    const id = await find(client, subject);
    expect(text(await call(client, 'get_email', { id }))).toContain('The meeting is at 14:00.');
    expect(text(await call(client, 'get_email_status', { id }))).toContain('Unread');
  });

  it('should save and preview a draft without delivery, then deliver it once and remove the draft', async () => {
    const { client } = await packed.connect(config());
    const subject = 'Packed journey draft';
    await call(client, 'save_draft', { to: ['bob@localhost'], subject, body: 'Ready for review.' });
    const id = await find(client, subject, 'test', 'Drafts');
    const preview = await call(client, 'send_draft', { id, dryRun: true });
    expect(preview.structuredContent).toMatchObject({ ok: true, dryRun: true });
    expect(text(await call(client, 'list_emails', { account: 'bob', subject }))).toContain(
      'No emails found',
    );
    expect(await find(client, subject, 'test', 'Drafts')).toBe(id);
    await call(client, 'send_draft', { id });
    await waitForDelivery(subject, { user: 'bob' });
    const delivered = await call(client, 'list_emails', { account: 'bob', subject });
    expect(text(delivered)).toContain('[INBOX] 1 emails');
    const receivedId = await find(client, subject, 'bob');
    expect(text(await call(client, 'get_email', { account: 'bob', id: receivedId }))).toContain(
      'Ready for review.',
    );
    expect(text(await call(client, 'list_emails', { mailbox: 'Drafts', subject }))).toContain(
      'No emails found',
    );
  });

  it('should preserve the original message ID in a delivered reply', async () => {
    const subject = 'Packed journey reply';
    const messageId = await seedEmail({ from: 'bob@localhost', subject, text: 'Can we meet?' });
    await waitForDelivery(subject);
    const { client } = await packed.connect(config(), { MCP_EMAIL_TOOLSET: 'full' });
    const id = await find(client, subject);
    await call(client, 'reply_email', { id, body: 'Yes, at 14:00.' });
    await waitForDelivery(`Re: ${subject}`, { user: 'bob' });
    const replyId = await find(client, `Re: ${subject}`, 'bob');
    const exported = await call(client, 'export_email', { account: 'bob', id: replyId });
    const blocks = exported.content as { type: string; text?: string }[];
    const encoded = blocks.find((block) => block.text?.includes('Base64 Content'))?.text;
    const source = Buffer.from(
      encoded?.split('--- Base64 Content ---')[1].trim() ?? '',
      'base64',
    ).toString('utf8');
    expect(source).toContain(`In-Reply-To: ${messageId}`);
    expect(source).toContain('Yes, at 14:00.');
  });

  it('should download an attachment and reject writes outside the working directory', async () => {
    const subject = 'Packed journey attachment';
    await seedEmail({
      subject,
      attachments: [{ filename: 'agenda.txt', content: 'Meet at 14:00.' }],
    });
    await waitForDelivery(subject);
    const { client, home } = await packed.connect(config());
    const id = await find(client, subject);
    const downloaded = await call(client, 'download_attachment', { id, filename: 'agenda.txt' });
    expect(text(downloaded)).toContain(Buffer.from('Meet at 14:00.').toString('base64'));
    const outside = path.join(home, '..', 'outside.txt');
    const refused = await client.callTool({
      name: 'download_attachment',
      arguments: { id, filename: 'agenda.txt', savePath: outside },
    });
    expect(refused.isError).toBe(true);
    await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should enforce the recommended read-only client config at the mailbox and filesystem', async () => {
    const subject = 'Packed journey read only';
    await seedEmail({ subject, text: 'Do not change my flags.' });
    await waitForDelivery(subject);
    const backgroundConfig = config().replace(
      '[[accounts]]',
      '[settings.watcher]\nenabled = true\n[[accounts]]',
    );
    const { client, home } = await packed.connect(backgroundConfig, {
      MCP_EMAIL_READ_ONLY: 'true',
      MCP_EMAIL_TOOLSET: 'core',
    });
    const { tools } = await client.listTools();
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.map((tool) => tool.name)).not.toContain('send_email');
    const denied = await client.callTool({ name: 'send_email', arguments: {} });
    expect(denied.isError).toBe(true);
    const id = await find(client, subject);
    await call(client, 'get_email', { id, markRead: true });
    expect(text(await call(client, 'get_email_status', { id }))).toContain('Unread');
    // Use full here to exercise export, which is intentionally absent from core.
    const full = await packed.connect(backgroundConfig, {
      MCP_EMAIL_READ_ONLY: 'true',
      MCP_EMAIL_TOOLSET: 'full',
    });
    expect(text(await call(full.client, 'get_watcher_status'))).toContain('Watcher is not active');
    const refused = await full.client.callTool({
      name: 'export_email',
      arguments: { id, savePath: 'message.eml' },
    });
    expect(refused.isError).toBe(true);
    expect(await readdir(home)).toEqual(['config']);
    await expect(access(path.join(full.home, 'message.eml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('should terminate the server process when the MCP client disconnects', async () => {
    const { client, transport } = await packed.connect(config());
    const pid = transport.pid;
    expect(pid).not.toBeNull();
    await call(client, 'list_mailboxes');
    await client.close();
    expect(() => process.kill(pid as number, 0)).toThrow();
  });
});
