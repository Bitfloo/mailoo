/**
 * Streamable HTTP entry that gives each MCP session its own scope.
 * Idle sessions are closed by the session table, which drops that scope.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type ConnectionManager from '../connections/manager.js';
import { bindServer, markInitialized, mcpLog } from '../logging.js';
import registerAllPrompts from '../prompts/register.js';
import registerAllResources from '../resources/register.js';
import createServer, { PKG_VERSION } from '../server.js';
import type CalendarService from '../services/calendar.service.js';
import type ImapService from '../services/imap.service.js';
import type LocalCalendarService from '../services/local-calendar.service.js';
import { MailArrival } from '../services/mail-arrival/index.js';
import type RemindersService from '../services/reminders.service.js';
import type TemplateService from '../services/template.service.js';
import registerAllTools from '../tools/register.js';
import type { AppConfig } from '../types/index.js';
import type { HttpSessionScope } from './http-session-scope.js';
import { createHttpSessionScope, httpSessionQueueDir } from './http-session-scope.js';
import HttpSessionStore, {
  DEFAULT_HTTP_MAX_SESSIONS,
  DEFAULT_HTTP_SESSION_TTL_MS,
} from './http-sessions.js';
import { readLimitedBody, resolveHttpRoute } from './http-transport.js';
import { maybeStartMailboxWriters } from './write-side-effects.js';

export interface HttpMcpHostOptions {
  config: AppConfig;
  connections: ConnectionManager;
  imap: ImapService;
  templateService: TemplateService;
  calendarService: CalendarService;
  localCalendarService: LocalCalendarService;
  remindersService: RemindersService;
  bodyLimitBytes: number;
  queueRoot?: string;
  maxSessions?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface HttpMcpHost {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  scopeFor: (sessionId: string) => HttpSessionScope | undefined;
  close: () => Promise<void>;
}

export async function createHttpMcpHost(options: HttpMcpHostOptions): Promise<HttpMcpHost> {
  const queueRoot = options.queueRoot ?? path.join(os.tmpdir(), 'mailoo-http-sessions');
  await fs.mkdir(queueRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(queueRoot, 0o700);

  const sessions = new HttpSessionStore<StreamableHTTPServerTransport>(
    options.maxSessions ?? DEFAULT_HTTP_MAX_SESSIONS,
    options.ttlMs ?? DEFAULT_HTTP_SESSION_TTL_MS,
    options.now,
  );
  const scopes = new Map<string, HttpSessionScope>();
  const disposing: Promise<void>[] = [];
  const canWrite = !options.config.settings.readOnly;

  const release = (sid: string, scope: HttpSessionScope): void => {
    sessions.delete(sid);
    scopes.delete(sid);
    disposing.push(scope.dispose());
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const route = resolveHttpRoute(req.method, req.url);
    if (route === 'method') {
      res.writeHead(405, { Allow: req.url === '/health' ? 'GET' : 'GET, POST, DELETE' });
      res.end();
      return;
    }
    if (route === 'missing') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    if (route === 'health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: PKG_VERSION }));
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      const raw = await readLimitedBody(req, options.bodyLimitBytes);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString());
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Parse error' },
              id: null,
            }),
          );
          return;
        }
      }
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    let transport: StreamableHTTPServerTransport;
    let trackedId = sessionId;
    let created: HttpSessionScope | undefined;
    let registered = false;

    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing && sessionId) {
      transport = existing;
      sessions.touch(sessionId);
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
      try {
        const sid = randomUUID();
        const queueDir = httpSessionQueueDir(queueRoot, sid);
        await fs.mkdir(queueDir, { mode: 0o700 });
        await fs.chmod(queueDir, 0o700);
        const scope = createHttpSessionScope({
          id: sid,
          queueDir,
          rateLimit: options.config.settings.rateLimit,
          saveToSent: options.config.settings.saveToSent,
          watcher: options.config.settings.watcher,
          accounts: options.config.accounts,
          hooks: options.config.settings.hooks,
          connections: options.connections,
          imap: options.imap,
        });
        created = scope;
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sid,
          onsessioninitialized: (initializedId) => {
            sessions.set(initializedId, newTransport);
            scopes.set(initializedId, scope);
            sessions.beginRequest(initializedId);
            trackedId = initializedId;
            registered = true;
          },
        });
        newTransport.onclose = () => {
          release(newTransport.sessionId ?? sid, scope);
        };
        const mcpServer = createServer();
        bindServer(mcpServer);
        registerAllTools(
          mcpServer,
          options.connections,
          options.imap,
          scope.smtp,
          options.config,
          options.templateService,
          options.calendarService,
          options.localCalendarService,
          options.remindersService,
          scope.scheduler,
          scope.watcher,
          scope.hooks,
        );
        registerAllResources(
          mcpServer,
          options.connections,
          options.imap,
          options.templateService,
          scope.scheduler,
        );
        registerAllPrompts(mcpServer);
        await mcpServer.connect(newTransport);

        const ls = mcpServer.server;
        ls.oninitialized = () => {
          markInitialized();
          // eslint-disable-next-line no-void
          void (async () => {
            try {
              const mailArrival = await MailArrival.tryCreate({
                config: options.config.settings.systemOne,
                imap: options.imap,
                apiKey: process.env.TYPESAFE_API_KEY,
                accounts: options.config.accounts,
                moveToPaths: options.config.settings.hooks.rules
                  .map((rule) => rule.actions.moveTo)
                  .filter((folder): folder is string => Boolean(folder)),
              });
              scope.hooks.setMailArrival(mailArrival);
              if (mailArrival && !options.config.settings.watcher.enabled) {
                await mcpLog(
                  'warning',
                  'server',
                  'system_one is enabled but watcher is off — no arrivals will be classified',
                );
              }

              const started = await maybeStartMailboxWriters(canWrite, {
                startHooks: () => {
                  const clientCaps = ls.getClientCapabilities?.() ?? {};
                  scope.hooks.start(ls, { sampling: clientCaps.sampling != null });
                },
                startWatcher: async () => {
                  await scope.watcher.start();
                },
                startScheduler: () => {
                  scope.armScheduler();
                },
              });
              if (!started) {
                await mcpLog('info', 'server', 'read_only: skipping hooks (HTTP mode)');
                return;
              }
              await mcpLog('info', 'server', 'Mailoo ready (HTTP mode)');
            } catch (err) {
              process.stderr.write(
                `[mailoo] hooks init error: ${err instanceof Error ? err.message : String(err)}\n`,
              );
            }
          })();
        };

        transport = newTransport;
      } catch (err) {
        if (created && !registered) disposing.push(created.dispose());
        throw err;
      }
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: provide mcp-session-id or send an initialize request',
          },
          id: null,
        }),
      );
      return;
    }

    if (trackedId && !registered) sessions.beginRequest(trackedId);
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      if (trackedId) sessions.endRequest(trackedId);
      if (created && !registered) disposing.push(created.dispose());
      sessions.evict();
    }
  };

  return {
    handle,
    scopeFor(sessionId: string) {
      return scopes.get(sessionId);
    },
    async close() {
      await Promise.allSettled(sessions.values().map(async (transport) => transport.close()));
      await Promise.allSettled(disposing);
      await Promise.allSettled([...scopes.values()].map(async (scope) => scope.dispose()));
    },
  };
}
