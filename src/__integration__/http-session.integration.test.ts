/**
 * Two HTTP clients on one process. Each initialize gets its own MCP session.
 * Scheduled mail stays in the process queue after a session closes.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import ConnectionManager from '../connections/manager.js';
import { boundServerCount, mcpLog } from '../logging.js';
import { createHttpMcpHost } from '../safety/http-mcp-host.js';
import { resolveHttpListen, startGuardedHttpServers } from '../safety/http-transport.js';
import CalendarService from '../services/calendar.service.js';
import HooksService from '../services/hooks.service.js';
import ImapService from '../services/imap.service.js';
import LocalCalendarService from '../services/local-calendar.service.js';
import RemindersService from '../services/reminders.service.js';
import TemplateService from '../services/template.service.js';
import type { AppConfig } from '../types/index.js';

function testConfig(): AppConfig {
  return {
    settings: {
      rateLimit: 2,
      readOnly: true,
      saveToSent: false,
      watcher: { enabled: false, folders: ['INBOX'], idleTimeout: 1740 },
      systemOne: {
        enabled: false,
        model: 'jev-latest',
        includeBody: false,
        bodyMaxChars: 6000,
        autoMove: false,
        autoFlag: false,
        folders: [],
        sourceFolders: ['INBOX'],
        thresholds: {
          folderFitMin: 0.85,
          spamHigh: 0.72,
          spamUncertainLow: 0.4,
          spamUncertainHigh: 0.6,
          injectionHigh: 0.75,
          importanceFlagMin: 3,
          importanceMinConfidence: 0.7,
          isCriticalMin: 0.85,
        },
      },
      hooks: {
        onNewEmail: 'none',
        preset: 'priority-focus',
        autoLabel: false,
        autoFlag: false,
        batchDelay: 0,
        rules: [],
        alerts: {
          desktop: false,
          sound: false,
          urgencyThreshold: 'high',
          webhookUrl: '',
          webhookEvents: [],
        },
      },
    },
    accounts: [],
  };
}

function initializeBody(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mailoo-session-test', version: '0.0.0' },
    },
  });
}

function postInitialize(
  port: number,
  id: number,
): Promise<{ status: number; sessionId: string; body: string }> {
  return postRpc(port, initializeBody(id));
}

function postRpc(
  port: number,
  payload: string,
  sessionId?: string,
): Promise<{ status: number; sessionId: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => {
          const header = res.headers['mcp-session-id'];
          const sessionId = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
          resolve({
            status: res.statusCode ?? 0,
            sessionId,
            body: Buffer.concat(parts).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Opens a session's standalone GET event stream and collects what arrives on it. */
function openEventStream(
  port: number,
  sessionId: string,
): Promise<{ text: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const parts: string[] = [];
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/mcp',
        headers: {
          host: `127.0.0.1:${port}`,
          accept: 'text/event-stream',
          'mcp-session-id': sessionId,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`event stream answered ${res.statusCode}`));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => parts.push(chunk));
        resolve({
          text: () => parts.join(''),
          close: () => {
            req.destroy();
          },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP session isolation', () => {
  const ttlMs = 5_000;

  it('should keep scheduled mail after the HTTP session that created it closes', async () => {
    const queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-http-host-'));
    const scheduledDir = path.join(queueRoot, 'scheduled');
    const connections = new ConnectionManager([]);
    const host = await createHttpMcpHost({
      config: testConfig(),
      connections,
      imap: new ImapService(connections),
      templateService: new TemplateService(path.join(queueRoot, 'templates')),
      calendarService: new CalendarService(),
      localCalendarService: new LocalCalendarService(),
      remindersService: new RemindersService(),
      bodyLimitBytes: 1024 * 1024,
      scheduledDir,
      ttlMs,
      now: () => 1_000,
    });
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, host.handle);
    try {
      const first = await postInitialize(listener.port, 1);
      const second = await postInitialize(listener.port, 2);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.sessionId).not.toBe('');
      expect(first.sessionId).not.toBe(second.sessionId);

      const scopeA = host.scopeFor(first.sessionId);
      const scopeB = host.scopeFor(second.sessionId);
      if (!scopeA || !scopeB) {
        throw new Error('missing session scope');
      }
      const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const scheduled = await scopeA.scheduler.schedule('box', {
        to: ['a@example.com'],
        subject: 'shared',
        body: 'hidden',
        sendAt,
      });
      expect((await scopeB.scheduler.list({ status: 'pending' })).map((item) => item.id)).toEqual([
        scheduled.id,
      ]);
      expect(host.scopeFor(first.sessionId)).toBeDefined();
      await host.close();
      const queueFile = path.join(scheduledDir, `${scheduled.id}.json`);
      expect(JSON.parse(await fs.readFile(queueFile, 'utf8'))).toMatchObject({
        subject: 'shared',
        status: 'pending',
      });
    } finally {
      await host.close();
      await listener.close();
      await fs.rm(queueRoot, { recursive: true, force: true });
    }
  });

  it('should drop an idle HTTP session without deleting scheduled mail', async () => {
    let now = 1_000;
    const queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-http-host-'));
    const scheduledDir = path.join(queueRoot, 'scheduled');
    const connections = new ConnectionManager([]);
    const host = await createHttpMcpHost({
      config: testConfig(),
      connections,
      imap: new ImapService(connections),
      templateService: new TemplateService(path.join(queueRoot, 'templates')),
      calendarService: new CalendarService(),
      localCalendarService: new LocalCalendarService(),
      remindersService: new RemindersService(),
      bodyLimitBytes: 1024 * 1024,
      scheduledDir,
      ttlMs,
      now: () => now,
    });
    const policy = resolveHttpListen({ port: 0, host: '127.0.0.1' });
    const listener = await startGuardedHttpServers(policy, host.handle);
    try {
      const first = await postInitialize(listener.port, 1);
      now = 2_000;
      const second = await postInitialize(listener.port, 2);
      const scopeA = host.scopeFor(first.sessionId);
      const scopeB = host.scopeFor(second.sessionId);
      if (!scopeA || !scopeB) {
        throw new Error('missing session scope');
      }
      const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const expired = await scopeA.scheduler.schedule('box', {
        to: ['a@example.com'],
        subject: 'from-idle-session',
        body: 'hidden',
        sendAt,
      });
      await scopeB.scheduler.schedule('box', {
        to: ['b@example.com'],
        subject: 'from-live-session',
        body: 'hidden',
        sendAt,
      });
      now = 1_000 + ttlMs + 1;
      const third = await postInitialize(listener.port, 3);
      expect(third.status).toBe(200);
      expect(host.scopeFor(first.sessionId)).toBeUndefined();
      expect(
        (await host.scheduler.list({ status: 'pending' })).map((item) => item.subject).sort(),
      ).toEqual(['from-idle-session', 'from-live-session']);
      expect(
        JSON.parse(await fs.readFile(path.join(scheduledDir, `${expired.id}.json`), 'utf8')),
      ).toMatchObject({
        subject: 'from-idle-session',
      });
    } finally {
      await host.close();
      await listener.close();
      await fs.rm(queueRoot, { recursive: true, force: true });
    }
  });
});

const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });

async function startHost(clock: { now: number }, ttlMs: number, config = testConfig()) {
  const queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-http-host-'));
  const connections = new ConnectionManager([]);
  const host = await createHttpMcpHost({
    config,
    connections,
    imap: new ImapService(connections),
    templateService: new TemplateService(path.join(queueRoot, 'templates')),
    calendarService: new CalendarService(),
    localCalendarService: new LocalCalendarService(),
    remindersService: new RemindersService(),
    bodyLimitBytes: 1024 * 1024,
    scheduledDir: path.join(queueRoot, 'scheduled'),
    ttlMs,
    now: () => clock.now,
  });
  const listener = await startGuardedHttpServers(
    resolveHttpListen({ port: 0, host: '127.0.0.1' }),
    host.handle,
  );
  return {
    host,
    port: listener.port,
    async stop() {
      await host.close();
      await listener.close();
      await fs.rm(queueRoot, { recursive: true, force: true });
    },
  };
}

// Streamable HTTP (2025-06-18, Session Management): an unknown or terminated
// session id gets 404, which tells the client to send a new initialize.
// A 400 left an evicted client with no way back.
describe('HTTP session ids the host does not hold', () => {
  const ttlMs = 5_000;

  it('should answer 404 with JSON-RPC error -32001 when the session id is unknown', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    try {
      const response = await postRpc(running.port, TOOLS_LIST, 'no-such-session');

      expect({ status: response.status, body: JSON.parse(response.body) }).toEqual({
        status: 404,
        body: { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null },
      });
    } finally {
      await running.stop();
    }
  });

  it('should answer 404 when the session was evicted after its idle TTL', async () => {
    const clock = { now: 1_000 };
    const running = await startHost(clock, ttlMs);
    try {
      const first = await postInitialize(running.port, 1);
      clock.now = 1_000 + ttlMs + 1;
      await postInitialize(running.port, 2);

      const response = await postRpc(running.port, TOOLS_LIST, first.sessionId);

      expect(response.status).toBe(404);
    } finally {
      await running.stop();
    }
  });

  it('should answer 404 when an initialize request carries an unknown session id', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    try {
      const response = await postRpc(running.port, initializeBody(1), 'no-such-session');

      expect(response.status).toBe(404);
    } finally {
      await running.stop();
    }
  });

  it('should keep 400 when a non-initialize request has no session id', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    try {
      const response = await postRpc(running.port, TOOLS_LIST);

      expect(response.status).toBe(400);
    } finally {
      await running.stop();
    }
  });
});

// Each session binds its own McpServer for logging. One module-wide reference
// kept only the session bound last, so its close silenced every other client.
describe('HTTP session logging', () => {
  it('should deliver a log to a live session after the session bound last terminated', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const url = new URL(`http://127.0.0.1:${running.port}/mcp`);
    const live = new Client({ name: 'mailoo-live', version: '0.0.0' });
    const received: unknown[] = [];
    live.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      received.push(notification.params.data);
    });
    const endedTransport = new StreamableHTTPClientTransport(url);
    const ended = new Client({ name: 'mailoo-ended', version: '0.0.0' });
    try {
      await live.connect(new StreamableHTTPClientTransport(url));
      await ended.connect(endedTransport);
      await endedTransport.terminateSession();

      // The live client opens its notification stream asynchronously after the
      // handshake; repeat the log until that stream is up.
      await vi.waitFor(
        async () => {
          await mcpLog('info', 'test', 'after terminate');
          expect(received).toContain('after terminate');
        },
        { timeout: 5_000, interval: 100 },
      );
    } finally {
      await Promise.allSettled([live.close(), ended.close()]);
      await running.stop();
    }
  });
});

// A closed session's McpServer stayed in the logging table, so a long-lived
// host kept every server it ever created.
describe('HTTP session logging cleanup', () => {
  it('should unbind the session server from logging when the session terminates', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${running.port}/mcp`),
    );
    const client = new Client({ name: 'mailoo-unbind', version: '0.0.0' });
    const before = boundServerCount();
    try {
      await client.connect(transport);
      const connected = boundServerCount();
      await transport.terminateSession();

      await vi.waitFor(() => {
        expect({ connected, after: boundServerCount() }).toEqual({
          connected: before + 1,
          after: before,
        });
      });
    } finally {
      await client.close().catch(() => undefined);
      await running.stop();
    }
  });
});

// Logs before a client's `initialized` notification break clients that read
// stdout strictly; one session's handshake must not mark another session.
describe('HTTP session logging before the handshake', () => {
  it('should not send logs to a session that has not sent initialized when another session has', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const live = new Client({ name: 'mailoo-live', version: '0.0.0' });
    const received: unknown[] = [];
    live.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      received.push(notification.params.data);
    });
    let pendingStream: { text: () => string; close: () => void } | undefined;
    try {
      // The pending session is bound first, so marking every bound server
      // when the live client finishes its handshake would include it.
      const pending = await postInitialize(running.port, 1);
      pendingStream = await openEventStream(running.port, pending.sessionId);
      await live.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );

      // The live client opens its notification stream asynchronously after the
      // handshake; repeat each log until it arrives there.
      await vi.waitFor(
        async () => {
          await mcpLog('info', 'test', 'first');
          expect(received).toContain('first');
        },
        { timeout: 5_000, interval: 100 },
      );
      await vi.waitFor(
        async () => {
          await mcpLog('info', 'test', 'second');
          expect(received).toContain('second');
        },
        { timeout: 5_000, interval: 100 },
      );

      expect(pendingStream.text()).not.toContain('notifications/message');
    } finally {
      pendingStream?.close();
      await live.close().catch(() => undefined);
      await running.stop();
    }
  });
});

// A session dispose that rejected had no handler until host.close(). Node ends
// the process on an unhandled rejection, so one failed cleanup dropped every
// session.
describe('HTTP session dispose', () => {
  it('should report a failed session dispose on stderr when the session terminates', async () => {
    const writable = testConfig();
    writable.settings.readOnly = false;
    const running = await startHost({ now: 1_000 }, 5_000, writable);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${running.port}/mcp`),
    );
    const client = new Client({ name: 'mailoo-dispose', version: '0.0.0' });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await client.connect(transport);
      await running.host.ready;
      // Refreshing the sampling target is the step of dispose that can throw;
      // nothing outside the host reaches it otherwise.
      const refresh = vi
        .spyOn(HooksService.prototype, 'setSamplingTarget')
        .mockImplementation(() => {
          throw new Error('sampling target refresh failed');
        });
      await transport.terminateSession();

      await vi.waitFor(() => {
        expect(stderr.mock.calls.map(([chunk]) => String(chunk))).toContain(
          '[mailoo] HTTP session dispose failed: sampling target refresh failed\n',
        );
      });
      refresh.mockRestore();
    } finally {
      stderr.mockRestore();
      vi.restoreAllMocks();
      await client.close().catch(() => undefined);
      await running.stop();
    }
  });
});
