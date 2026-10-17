/**
 * Two HTTP clients on one process. Each initialize gets its own MCP session.
 * Scheduled mail stays in the process queue after a session closes.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import ConnectionManager from '../connections/manager.js';
import { createHttpMcpHost } from '../safety/http-mcp-host.js';
import { resolveHttpListen, startGuardedHttpServers } from '../safety/http-transport.js';
import CalendarService from '../services/calendar.service.js';
import HooksService from '../services/hooks.service.js';
import ImapService from '../services/imap.service.js';
import LocalCalendarService from '../services/local-calendar.service.js';
import RemindersService from '../services/reminders.service.js';
import TemplateService from '../services/template.service.js';
import {
  initializeBody,
  postInitialize,
  postRpc,
  startHost,
  TOOLS_LIST,
  testConfig,
} from './helpers/http-host.js';

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

// Streamable HTTP (2025-06-18, Session Management): an unknown or terminated
// session id gets 404, which tells the client to send a new initialize.
// A 400 left an evicted client with no way back.
describe('HTTP session ids the host does not hold', () => {
  const ttlMs = 5_000;

  it('should answer 404 with JSON-RPC error -32001 when the session id is unknown', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    try {
      const response = await postRpc(running.port, TOOLS_LIST, { sessionId: 'no-such-session' });

      expect({
        status: response.status,
        contentType: response.headers['content-type'],
        body: JSON.parse(response.body),
      }).toEqual({
        status: 404,
        contentType: 'application/json',
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

      const response = await postRpc(running.port, TOOLS_LIST, { sessionId: first.sessionId });

      expect(response.status).toBe(404);
    } finally {
      await running.stop();
    }
  });

  it('should answer 404 when an initialize request carries an unknown session id', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    try {
      const response = await postRpc(running.port, initializeBody(1), {
        sessionId: 'no-such-session',
      });

      expect(response.status).toBe(404);
    } finally {
      await running.stop();
    }
  });

  it('should keep 400 when a non-initialize request has no session id', async () => {
    const running = await startHost({ now: 1_000 }, ttlMs);
    try {
      const response = await postRpc(running.port, TOOLS_LIST);

      expect({
        status: response.status,
        contentType: response.headers['content-type'],
        body: JSON.parse(response.body),
      }).toEqual({
        status: 400,
        contentType: 'application/json',
        body: {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: provide mcp-session-id or send an initialize request',
          },
          id: null,
        },
      });
    } finally {
      await running.stop();
    }
  });
});

// The host parses a POST body before it routes; a body that is not JSON gets
// the JSON-RPC parse error, not the generic 400 for a missing session id.
describe('HTTP request bodies', () => {
  it('should answer 400 with JSON-RPC error -32700 when the POST body is not JSON', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    try {
      const response = await postRpc(running.port, '{not json');

      expect({
        status: response.status,
        contentType: response.headers['content-type'],
        body: JSON.parse(response.body),
      }).toEqual({
        status: 400,
        contentType: 'application/json',
        body: { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      });
    } finally {
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
