/**
 * A token endpoint that echoes token fields in its error body must not reach a tool result or
 * the audit log: the first goes to the client and the model, the second stays on disk.
 * The IMAP connect never starts, because the token step fails before ImapFlow is built.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import ConnectionManager from '../connections/manager.js';
import createServer from '../server.js';
import ImapService from '../services/imap.service.js';
import OAuthService from '../services/oauth.service.js';
import { readAuditEntries } from '../test-support/audit-home.js';
import type { TokenRequest } from '../test-support/token-endpoint.js';
import {
  echoingRefusal,
  fakeTokenEndpoint,
  googleConfig,
  leakedSecretsIn,
  leakyInvalidGrant,
} from '../test-support/token-endpoint.js';
import type { AccountConfig, AuditEntry, OAuth2Config } from '../types/index.js';
import registerManageTools from './manage.tool.js';

const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const REFUSAL =
  'OAuth2 token refresh failed (400): invalid_grant: Token has been expired or revoked.';

const ARGS = { account: 'work', id: '42', mailbox: 'INBOX', action: 'read' };

interface TextToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

function isTextToolResult(result: unknown): result is TextToolResult {
  if (typeof result !== 'object' || result === null || !('content' in result)) return false;
  return Array.isArray(result.content);
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'mailoo-oauth-error', version: '0.0.0' });
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

/** mark_email on an OAuth2 account whose refresh token the provider has revoked. */
async function markEmailOnRevokedAccount(
  refusal: (request: TokenRequest) => Response = leakyInvalidGrant(400),
  oauth2: OAuth2Config = googleConfig(),
) {
  const calls = fakeTokenEndpoint(refusal);
  const account: AccountConfig = {
    name: 'work',
    email: 'me@example.com',
    username: 'me@example.com',
    oauth2,
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
  };
  const server = createServer();
  registerManageTools(
    server,
    new ImapService(new ConnectionManager([account], new OAuthService())),
  );
  const result = await callTool(server, 'mark_email', ARGS);
  return { result, calls };
}

/**
 * The audit entries `act` appended. The file shares one audit home, since audit.ts fixes its
 * log path when it loads, so the entries earlier tests wrote stay in the log.
 */
async function auditEntriesWrittenBy(act: () => Promise<unknown>): Promise<AuditEntry[]> {
  const before = (await readAuditEntries(auditHome)).length;
  await act();
  return (await readAuditEntries(auditHome)).slice(before);
}

describe('mark_email on an OAuth2 account the provider refuses', () => {
  it('should return the refusal as isError text without the tokens the endpoint echoed', async () => {
    const { result, calls } = await markEmailOnRevokedAccount();

    expect({
      tokenUrls: calls.map((call) => call.url),
      isError: result.isError,
      content: result.content,
      leaked: leakedSecretsIn(result),
    }).toEqual({
      tokenUrls: ['https://oauth2.googleapis.com/token'],
      isError: true,
      content: [{ type: 'text', text: `Failed to mark email: ${REFUSAL}` }],
      leaked: [],
    });
  });

  it('should audit the refusal without the tokens the endpoint echoed', async () => {
    const written = await auditEntriesWrittenBy(async () => markEmailOnRevokedAccount());

    expect({
      written,
      leaked: leakedSecretsIn(written),
    }).toEqual({
      written: [
        {
          ts: expect.any(String),
          tool: 'mark_email',
          account: 'work',
          params: { id: '42', mailbox: 'INBOX', action: 'read' },
          result: 'error',
          error: REFUSAL,
        },
      ],
      leaked: [],
    });
  });
});

const CLIENT_SECRET = 'GOCSPX-m3Tz8Qw1Vd6Lk0Yh';
const REFRESH_TOKEN = '1//09Rb4Xn7Pc2Hs5FyJu';

const ECHOED_REFUSAL =
  'OAuth2 token refresh failed (400): invalid_grant: token [redacted] of client [redacted] revoked';

/** The provider refuses and quotes back the refresh token and client secret the request sent. */
async function markEmailWithEchoedSecrets() {
  return markEmailOnRevokedAccount(
    echoingRefusal((sent) => ({
      error: 'invalid_grant',
      error_description: `token ${sent.get('refresh_token') ?? ''} of client ${sent.get('client_secret') ?? ''} revoked`,
    })),
    googleConfig({ clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN }),
  );
}

describe('mark_email when the refusal echoes the secrets the token request sent', () => {
  it('should return the refusal with [redacted] in place of the refresh token and client secret', async () => {
    const { result } = await markEmailWithEchoedSecrets();

    expect({
      isError: result.isError,
      content: result.content,
      leaked: leakedSecretsIn(result, [REFRESH_TOKEN, CLIENT_SECRET], { fragments: true }),
    }).toEqual({
      isError: true,
      content: [{ type: 'text', text: `Failed to mark email: ${ECHOED_REFUSAL}` }],
      leaked: [],
    });
  });

  it('should audit the refusal with [redacted] in place of the refresh token and client secret', async () => {
    const written = await auditEntriesWrittenBy(markEmailWithEchoedSecrets);

    expect({
      errors: written.map((entry) => entry.error),
      leaked: leakedSecretsIn(written, [REFRESH_TOKEN, CLIENT_SECRET], { fragments: true }),
    }).toEqual({
      errors: [ECHOED_REFUSAL],
      leaked: [],
    });
  });
});
