/**
 * Two HTTP clients on one process. Each initialize gets its own MCP session.
 * Scheduled mail stays in the process queue after a session closes.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import ConnectionManager from '../connections/manager.js';
import { createHttpMcpHost } from '../safety/http-mcp-host.js';
import { resolveHttpListen, startGuardedHttpServers } from '../safety/http-transport.js';
import CalendarService from '../services/calendar.service.js';
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
  const payload = initializeBody(id);
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
