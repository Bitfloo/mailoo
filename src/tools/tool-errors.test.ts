/**
 * Clients treat a tool result as success unless isError is set. A handler
 * that throws, a get_emails fetch that fails, and a failed test notification
 * must all come back as isError text — including after an SDK upgrade that
 * stops wrapping a thrown handler.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import createServer from '../server.js';
import NotifierService from '../services/notifier.service.js';
import registerEmailsTools from './emails.tool.js';
import { registerWatcherWriteTools } from './watcher.tool.js';

const FAILURE = 'mailbox unavailable';

interface TextToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function isTextToolResult(result: unknown): result is TextToolResult {
  if (typeof result !== 'object' || result === null || !('content' in result)) return false;
  return Array.isArray(result.content);
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<TextToolResult> {
  const client = new Client({ name: 'mailoo-tool-errors', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    if (!isTextToolResult(result)) throw new Error('tool result has no text content');
    return result;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function expectFailure(result: TextToolResult): void {
  expect(result.isError).toBe(true);
  expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(FAILURE) });
}

describe('tool failures return isError', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return isError with the message as text when a handler throws', async () => {
    const server = createServer();
    server.registerTool('throwing_probe', { inputSchema: {} }, async () => {
      throw new Error(FAILURE);
    });
    const result = await callTool(server, 'throwing_probe', {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: FAILURE }]);
  });

  it('should return isError when get_emails cannot fetch a message', async () => {
    const server = createServer();
    registerEmailsTools(
      server,
      { getEmail: async () => Promise.reject(new Error(FAILURE)) } as never,
      false,
    );
    const result = await callTool(server, 'get_emails', {
      account: 'personal',
      ids: ['9'],
      mailbox: 'INBOX',
      format: 'text',
    });
    expectFailure(result);
  });

  it('should return isError when test_notification reports failure', async () => {
    vi.spyOn(NotifierService, 'checkPlatformSupport').mockResolvedValue({
      platform: 'test',
      supported: false,
      desktopTool: { name: 'none', available: false },
      soundTool: { name: 'none', available: false },
      issues: [],
      setupInstructions: ['open settings'],
    });
    const server = createServer();
    registerWatcherWriteTools(server, {
      getHooksConfig: () => ({
        onNewEmail: 'notify',
        preset: 'priority-focus',
        autoLabel: false,
        autoFlag: false,
        batchDelay: 5,
        rules: [],
        alerts: {},
      }),
      getNotifier: () => ({
        sendTestNotification: async () => ({ success: false, message: FAILURE }),
      }),
    } as never);
    const result = await callTool(server, 'test_notification', { sound: false });
    expectFailure(result);
  });
});
