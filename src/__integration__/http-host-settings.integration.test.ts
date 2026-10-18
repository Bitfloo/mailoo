/**
 * Settings and environment the HTTP host hands to process-wide services:
 * the sampling flag the hooks start with, TYPESAFE_API_KEY for the arrival
 * classifier, and save_to_sent for outgoing mail, plus how the boot of those
 * services reports its outcome.
 */

import fs from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

import WatcherService from '../services/watcher.service.js';
import type { AppConfig } from '../types/index.js';
import { startHost, testConfig } from './helpers/http-host.js';
import { buildTestAccount, createTestServices, TEST_ACCOUNT_NAME } from './helpers/index.js';

// send_email writes the audit log at import-time XDG paths; keep it under
// reports/ (gitignored), as the labels suite does.
vi.hoisted(() => {
  vi.stubEnv('XDG_DATA_HOME', `${process.cwd()}/reports/xdg-data`);
});

afterAll(async () => {
  await fs.rm(`${process.cwd()}/reports/xdg-data`, { recursive: true, force: true });
});

function writableConfig(): AppConfig {
  const config = testConfig();
  config.settings.readOnly = false;
  config.settings.hooks.onNewEmail = 'notify';
  return config;
}

/** The log lines the host sends its sessions while it boots for one client. */
async function bootLogs(config: AppConfig, capabilities: ClientCapabilities = {}) {
  const sent = vi.spyOn(McpServer.prototype, 'sendLoggingMessage');
  const running = await startHost({ now: 1_000 }, 5_000, config);
  const client = new Client({ name: 'mailoo-settings', version: '0.0.0' }, { capabilities });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
    );
    await running.host.ready;
    return sent.mock.calls.map(([params]) => String(params.data));
  } finally {
    sent.mockRestore();
    await client.close().catch(() => undefined);
    await running.stop();
  }
}

describe('HTTP host hooks', () => {
  // setSamplingTarget runs right after start, so the flag start gets shows only
  // in the line that announces the hooks.
  it.each([
    ['no', 'lacks', {}],
    ['yes', 'declares', { sampling: {} }],
  ])('should announce sampling=%s when the first session %s sampling', async (flag, _how, caps) => {
    const announced = (await bootLogs(writableConfig(), caps)).filter((line) =>
      line.startsWith('Hooks active'),
    );

    expect(announced.map((line) => /sampling=(\w+)$/.exec(line)?.[1])).toEqual([flag]);
  });
});

describe('HTTP host arrival classifier', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // With system_one on and the watcher off, the host warns only once the
  // classifier exists, and the classifier exists only with an API key.
  it('should build the classifier from TYPESAFE_API_KEY', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key-not-real');
    const config = testConfig();
    config.settings.systemOne.enabled = true;

    const logs = await bootLogs(config);

    expect(logs).toContain(
      'system_one is enabled but watcher is off — no arrivals will be classified',
    );
  });

  // folders[] is empty in testConfig, so the classifier says so once it is built.
  it('should not warn about the watcher when the watcher is enabled', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key-not-real');
    const config = testConfig();
    config.settings.systemOne.enabled = true;
    config.settings.watcher.enabled = true;

    const logs = await bootLogs(config);

    expect({
      built: logs.includes('system_one: folders[] is empty — classify/flag only; no MOVE'),
      warned: logs.includes(
        'system_one is enabled but watcher is off — no arrivals will be classified',
      ),
    }).toEqual({ built: true, warned: false });
  });

  // The hooks warn about an unused classifier only when they were handed one.
  it('should hand the classifier to the hooks', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key-not-real');
    const config = writableConfig();
    config.settings.hooks.onNewEmail = 'none';
    config.settings.systemOne.enabled = true;

    const logs = await bootLogs(config);

    expect(logs).toContain('system_one is enabled but on_new_email is none — not subscribing');
  });

  it('should check the hook rules move_to folders against the account', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key-not-real');
    const config = testConfig();
    config.settings.systemOne.enabled = true;
    config.settings.hooks.rules = [
      { name: 'archive', match: { from: 'example.com' }, actions: { moveTo: 'NoSuchFolder' } },
    ];
    config.accounts = [buildTestAccount()];

    const logs = await bootLogs(config);

    expect(logs).toContain(
      `system_one: unknown move_to path "NoSuchFolder" on ${TEST_ACCOUNT_NAME}`,
    );
  });
});

describe('HTTP host boot outcome', () => {
  const outcomes = ['read_only: skipping hooks (HTTP mode)', 'Mailoo ready (HTTP mode)'];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [true, outcomes[0]],
    [false, outcomes[1]],
  ])('should log one boot outcome when read_only is %s', async (readOnly, line) => {
    const config = writableConfig();
    config.settings.readOnly = readOnly;

    const logs = await bootLogs(config);

    expect(logs.filter((entry) => outcomes.includes(entry))).toEqual([line]);
  });

  // Nothing awaits the boot, so stderr is the only place a failure shows.
  it('should report a failed boot on stderr with its message', async () => {
    vi.spyOn(WatcherService.prototype, 'start').mockRejectedValueOnce(new Error('watch failed'));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await bootLogs(writableConfig());

    expect(
      write.mock.calls.map(([chunk]) => String(chunk)).filter((l) => l.startsWith('[mailoo]')),
    ).toEqual(['[mailoo] hooks init error: watch failed\n']);
  });
});

describe('HTTP host save_to_sent', () => {
  const sentMailbox = 'HttpSentCopies';

  it('should send without filing a Sent copy when settings.saveToSent is false', async () => {
    const account = buildTestAccount({ sentMailbox });
    const mail = createTestServices(account);
    await mail.imapService.createMailbox(TEST_ACCOUNT_NAME, sentMailbox);
    const config = writableConfig();
    config.settings.saveToSent = false;
    config.accounts = [account];
    const running = await startHost({ now: 1_000 }, 5_000, config);
    const client = new Client({ name: 'mailoo-save-to-sent', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );
      const result = await client.callTool({
        name: 'send_email',
        arguments: {
          account: TEST_ACCOUNT_NAME,
          to: ['test@localhost'],
          subject: 'save_to_sent off over HTTP',
          body: 'No Sent copy expected.',
        },
      });
      const mailboxes = await mail.imapService.listMailboxes(TEST_ACCOUNT_NAME);

      expect({
        isError: result.isError ?? false,
        filed: mailboxes.find((mailbox) => mailbox.path === sentMailbox)?.totalMessages,
      }).toEqual({ isError: false, filed: 0 });
    } finally {
      await client.close().catch(() => undefined);
      await running.stop();
      await mail.imapService.deleteMailbox(TEST_ACCOUNT_NAME, sentMailbox);
      await mail.connections.closeAll();
    }
  });
});
