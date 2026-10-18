import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  startFakeImap,
  startFakeSmtp,
  startTokenEndpoint,
} from '../test-support/fake-mail-servers.js';
import type { ScheduledEmail } from '../types/index.js';

// The XDG paths are fixed when the modules load, so a check with no queue directory
// writes under this temp root and never under the real state directory.
const xdgRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cli-xdg-'));
vi.stubEnv('XDG_CONFIG_HOME', path.join(xdgRoot, 'config'));
vi.stubEnv('XDG_STATE_HOME', path.join(xdgRoot, 'state'));

const { CONFIG_FILE, SCHEDULED_DIR } = await import('../config/xdg.js');
const { loadConfig } = await import('../config/loader.js');
const { default: ConnectionManager } = await import('../connections/manager.js');
const { checkScheduledEmails, formatCheckResult, runCheck, runList } = await import(
  './scheduler.js'
);

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(xdgRoot, { recursive: true, force: true });
});

// closeAll resolves before the server sees QUIT and FIN. Without it, the pooled
// socket stays open until nodemailer's ten-minute idle timeout, so two seconds
// separates the two outcomes.
const SOCKET_CLOSE_WAIT_MS = 2_000;

async function waitFor(done: () => boolean, deadline: number): Promise<void> {
  if (done() || Date.now() >= deadline) return;
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  await waitFor(done, deadline);
}

const DUE_IDS = ['3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b', '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6c'];

function queued(id: string, fields: Partial<ScheduledEmail> = {}): ScheduledEmail {
  return {
    id,
    account: 'work',
    to: ['recipient@example.test'],
    subject: 'Quarterly numbers',
    body: 'The figures are below.',
    html: false,
    sendAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    status: 'pending',
    attempts: 0,
    ...fields,
  };
}

describe('scheduler check command', () => {
  let root: string;
  let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;
  let imap: Awaited<ReturnType<typeof startFakeImap>>;
  let token: Awaited<ReturnType<typeof startTokenEndpoint>>;

  beforeEach(async () => {
    // The env overlay replaces the config file when these are set.
    vi.stubEnv('MCP_EMAIL_ADDRESS', '');
    vi.stubEnv('MCP_EMAIL_IMAP_HOST', '');
    vi.stubEnv('MCP_EMAIL_SMTP_HOST', '');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cli-check-'));
    [smtp, imap, token] = await Promise.all([
      startFakeSmtp(),
      startFakeImap(),
      startTokenEndpoint(),
    ]);
  });

  afterEach(async () => {
    await Promise.all([smtp.close(), imap.close(), token.close()]);
    await fs.rm(root, { recursive: true, force: true });
  });

  interface CheckOptions {
    auth?: 'password' | 'oauth2';
    saveToSent?: boolean;
    rateLimit?: number;
    due?: number;
  }

  async function writeConfig(
    { auth = 'password', saveToSent = false, rateLimit }: CheckOptions,
    configPath = path.join(root, 'config.toml'),
  ) {
    const credentials =
      auth === 'password'
        ? ['password = "not-a-secret"']
        : [
            '[accounts.oauth2]',
            'provider = "custom"',
            'client_id = "client-id"',
            'client_secret = "not-a-secret"',
            'refresh_token = "refresh-token"',
            `token_url = "${token.url}"`,
            `auth_url = "${token.url.replace('/token', '/auth')}"`,
          ];
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        '[settings]',
        `save_to_sent = ${String(saveToSent)}`,
        ...(rateLimit === undefined ? [] : [`rate_limit = ${rateLimit}`]),
        '',
        '[[accounts]]',
        'name = "work"',
        'email = "sender@example.test"',
        ...credentials,
        '',
        '[accounts.imap]',
        'host = "127.0.0.1"',
        `port = ${imap.port}`,
        'tls = false',
        '',
        '[accounts.smtp]',
        'host = "127.0.0.1"',
        `port = ${smtp.port}`,
        'tls = false',
        'starttls = false',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    return loadConfig(configPath);
  }

  async function writeDueEmails(
    options: CheckOptions,
    paths = { config: path.join(root, 'config.toml'), queue: path.join(root, 'scheduled') },
  ) {
    const config = await writeConfig(options, paths.config);
    const queueDir = paths.queue;
    await fs.mkdir(queueDir, { recursive: true });
    await Promise.all(
      DUE_IDS.slice(0, options.due ?? 1).map(async (id) => {
        await fs.writeFile(path.join(queueDir, `${id}.json`), JSON.stringify(queued(id)), {
          mode: 0o600,
        });
      }),
    );
    return { config, queueDir };
  }

  async function checkDueEmails(options: CheckOptions) {
    const { config, queueDir } = await writeDueEmails(options);
    return checkScheduledEmails(config, queueDir);
  }

  it('should print the outcome of the check it runs', async () => {
    const { config, queueDir } = await writeDueEmails({});
    const lines: string[] = [];
    await runCheck(
      async () => config,
      (line) => {
        lines.push(line);
      },
      queueDir,
    );
    expect(lines).toEqual(['✅ Sent 1 scheduled email(s)']);
  });

  // `mailoo scheduler check` calls runCheck with no arguments, so its defaults are what users run.
  it('should read the default config and print to the console when called with no arguments', async () => {
    await writeDueEmails({}, { config: CONFIG_FILE, queue: SCHEDULED_DIR });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCheck();
      expect(log.mock.calls).toEqual([['✅ Sent 1 scheduled email(s)']]);
    } finally {
      log.mockRestore();
      await fs.rm(path.dirname(CONFIG_FILE), { recursive: true, force: true });
      await fs.rm(SCHEDULED_DIR, { recursive: true, force: true });
    }
  });

  it('should print an email that is still sending and one that was sent when the list command runs', async () => {
    const config = await writeConfig({});
    const queueDir = path.join(root, 'scheduled');
    const sendAt = '2030-01-01T09:00:00.000Z';
    const sentAt = '2030-01-01T09:00:04.000Z';
    await fs.mkdir(path.join(queueDir, 'sent'), { recursive: true });
    const [sendingId, sentId] = DUE_IDS;
    await fs.writeFile(
      path.join(queueDir, `${sendingId}.json`),
      JSON.stringify(queued(sendingId, { sendAt, status: 'sending', attempts: 1 })),
    );
    await fs.writeFile(
      path.join(queueDir, 'sent', `${sentId}.json`),
      JSON.stringify(queued(sentId, { sendAt, status: 'sent', attempts: 1, sentAt })),
    );
    const lines: string[] = [];
    await runList(
      async () => config,
      (line) => {
        lines.push(line);
      },
      queueDir,
    );
    const row = `  3f2b8c1e | work → recipient@example.test | "Quarterly numbers" |`;
    expect(lines).toEqual([
      '\n📤 Sending (1):',
      `${row} ${sendAt}`,
      '\n✅ Sent (1):',
      `${row} sent ${sentAt}`,
    ]);
  });

  it('should send with the access token from the OAuth endpoint when the account uses oauth2', async () => {
    const result = await checkDueEmails({ auth: 'oauth2' });
    expect({ sent: result.sent, auths: [...new Set(smtp.auths)] }).toEqual({
      sent: 1,
      auths: ['XOAUTH2 user=sender@example.test\x01auth=Bearer access-from-token-endpoint\x01\x01'],
    });
  });

  it('should not open an IMAP connection when save_to_sent is false', async () => {
    const result = await checkDueEmails({ saveToSent: false });
    expect({ sent: result.sent, imapConnections: imap.connections() }).toEqual({
      sent: 1,
      imapConnections: 0,
    });
  });

  it('should close its SMTP connections when the check finishes', async () => {
    await checkDueEmails({});
    await waitFor(() => smtp.openSockets() === 0, Date.now() + SOCKET_CLOSE_WAIT_MS);
    expect(smtp.openSockets()).toBe(0);
  });

  it('should save a Sent copy over IMAP when save_to_sent is true', async () => {
    // The fake IMAP server turns the APPEND connection away; the send still counts.
    const result = await checkDueEmails({ saveToSent: true });
    expect({ sent: result.sent, triedImap: imap.connections() > 0 }).toEqual({
      sent: 1,
      triedImap: true,
    });
  });

  it('should hold back the second due email when rate_limit is 1', async () => {
    const result = await checkDueEmails({ rateLimit: 1, due: 2 });
    expect({ sent: result.sent, deferred: result.deferred }).toEqual({ sent: 1, deferred: 1 });
  });

  it('should close its connections when the check fails', async () => {
    const closeAll = vi.spyOn(ConnectionManager.prototype, 'closeAll');
    try {
      const config = await writeConfig({});
      // mkdir fails on a regular file, so the check rejects before it reads the queue.
      const queueDir = path.join(root, 'scheduled');
      await fs.writeFile(queueDir, '');
      const failed = await checkScheduledEmails(config, queueDir).then(
        () => false,
        () => true,
      );
      expect({ failed, closed: closeAll.mock.calls.length }).toEqual({ failed: true, closed: 1 });
    } finally {
      closeAll.mockRestore();
    }
  });
});

describe('scheduler check output', () => {
  const quiet = { sent: 0, failed: 0, deferred: 0, errors: [] };

  it('should say nothing was due when a check sends, fails and holds back nothing', () => {
    expect(formatCheckResult(quiet)).toEqual(['No overdue scheduled emails.']);
  });

  it('should report emails the rate limit held back instead of saying nothing was due', () => {
    expect(formatCheckResult({ ...quiet, deferred: 2 })).toEqual([
      '⏳ Held back by the rate limit: 2 (retried on the next check)',
    ]);
  });

  it('should report failed sends with their errors', () => {
    expect(formatCheckResult({ ...quiet, failed: 1, errors: ['x.json: 550'] })).toEqual([
      '❌ Failed: 1',
      '   x.json: 550',
    ]);
  });

  it('should print the error of a delivered email whose record was not updated', () => {
    const error = `${DUE_IDS[0]}.json: sent, but the queue record was not updated: EACCES`;
    expect(formatCheckResult({ ...quiet, sent: 1, errors: [error] })).toEqual([
      '✅ Sent 1 scheduled email(s)',
      `   ${error}`,
    ]);
  });
});
