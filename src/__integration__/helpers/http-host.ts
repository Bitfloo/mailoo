/**
 * One Mailoo HTTP host on a loopback port, and raw HTTP calls to it, for the
 * session integration suites.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import ConnectionManager from '../../connections/manager.js';
import { createHttpMcpHost } from '../../safety/http-mcp-host.js';
import { resolveHttpListen, startGuardedHttpServers } from '../../safety/http-transport.js';
import CalendarService from '../../services/calendar.service.js';
import ImapService from '../../services/imap.service.js';
import LocalCalendarService from '../../services/local-calendar.service.js';
import RemindersService from '../../services/reminders.service.js';
import TemplateService from '../../services/template.service.js';
import type { AppConfig } from '../../types/index.js';

export function testConfig(): AppConfig {
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

export function initializeBody(id: number): string {
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

export function postInitialize(
  port: number,
  id: number,
): Promise<{ status: number; sessionId: string; body: string }> {
  return postRpc(port, initializeBody(id));
}

export function postRpc(
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
export function openEventStream(
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

export async function startHost(clock: { now: number }, ttlMs: number, config = testConfig()) {
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
