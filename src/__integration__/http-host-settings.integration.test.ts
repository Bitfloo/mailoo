/**
 * Settings and environment the HTTP host hands to process-wide services:
 * the sampling flag the hooks start with, TYPESAFE_API_KEY for the arrival
 * classifier, and save_to_sent for outgoing mail.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

import type { AppConfig } from '../types/index.js';
import { startHost, testConfig } from './helpers/http-host.js';
import { buildTestAccount, createTestServices, TEST_ACCOUNT_NAME } from './helpers/index.js';

// send_email writes the audit log at import-time XDG paths; keep it under
// reports/ (gitignored), as the labels suite does.
vi.hoisted(() => {
  vi.stubEnv('XDG_DATA_HOME', `${process.cwd()}/reports/xdg-data`);
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
