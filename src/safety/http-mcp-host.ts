/**
 * Streamable HTTP entry. One bearer token is one principal, so account
 * state is process-wide. Each session owns an McpServer and a transport.
 * Idle sessions are closed by the session table.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { SCHEDULED_DIR } from '../config/xdg.js';
import type ConnectionManager from '../connections/manager.js';
import { bindServer, markInitialized, mcpLog } from '../logging.js';
import registerAllPrompts from '../prompts/register.js';
import registerAllResources from '../resources/register.js';
import createServer, { PKG_VERSION } from '../server.js';
import type CalendarService from '../services/calendar.service.js';
import { EmailEventBus } from '../services/event-bus.js';
import HooksService from '../services/hooks.service.js';
import type ImapService from '../services/imap.service.js';
import type LocalCalendarService from '../services/local-calendar.service.js';
import { MailArrival } from '../services/mail-arrival/index.js';
import type RemindersService from '../services/reminders.service.js';
import SchedulerService from '../services/scheduler.service.js';
import SmtpService from '../services/smtp.service.js';
import type TemplateService from '../services/template.service.js';
import WatcherService from '../services/watcher.service.js';
import registerAllTools from '../tools/register.js';
import type { AppConfig } from '../types/index.js';
import type { HttpSessionScope } from './http-session-scope.js';
import { createHttpSessionScope } from './http-session-scope.js';
import HttpSessionStore, {
  DEFAULT_HTTP_MAX_SESSIONS,
  DEFAULT_HTTP_SESSION_TTL_MS,
} from './http-sessions.js';
import { readLimitedBody, resolveHttpRoute } from './http-transport.js';
import RateLimiter from './rate-limiter.js';
import { maybeStartMailboxWriters } from './write-side-effects.js';

/**
 * Matches the OS scheduler cadence (launchd StartInterval 60 / cron "* * * * *"
 * in src/cli/scheduler.ts).
 */
const SCHEDULER_INTERVAL_MS = 60_000;

export interface HttpMcpHostOptions {
  config: AppConfig;
  connections: ConnectionManager;
  imap: ImapService;
  templateService: TemplateService;
  calendarService: CalendarService;
  localCalendarService: LocalCalendarService;
  remindersService: RemindersService;
  bodyLimitBytes: number;
  /** Test override. Production uses SCHEDULED_DIR. */
  scheduledDir?: string;
  maxSessions?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface HttpMcpHost {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  scopeFor: (sessionId: string) => HttpSessionScope | undefined;
  readonly ready: Promise<void>;
  readonly scheduler: SchedulerService;
  readonly events: EmailEventBus;
  close: () => Promise<void>;
}

interface SamplingCandidate {
  server: Server;
  sampling: boolean;
  order: number;
}

export async function createHttpMcpHost(options: HttpMcpHostOptions): Promise<HttpMcpHost> {
  const events = new EmailEventBus();
  const rateLimiter = new RateLimiter(options.config.settings.rateLimit);
  const smtp = new SmtpService(
    options.connections,
    rateLimiter,
    options.imap,
    options.config.settings.saveToSent,
  );
  const scheduler = new SchedulerService(smtp, options.imap, options.scheduledDir ?? SCHEDULED_DIR);
  const watcher = new WatcherService(
    options.config.settings.watcher,
    options.config.accounts,
    events,
  );
  const hooks = new HooksService(options.config.settings.hooks, options.imap, {
    events,
    sessionResourceListeners: true,
  });

  const sessions = new HttpSessionStore<StreamableHTTPServerTransport>(
    options.maxSessions ?? DEFAULT_HTTP_MAX_SESSIONS,
    options.ttlMs ?? DEFAULT_HTTP_SESSION_TTL_MS,
    options.now,
  );
  const scopes = new Map<string, HttpSessionScope>();
  const disposing: Promise<void>[] = [];
  const canWrite = !options.config.settings.readOnly;

  // Sampling target policy: hooks start ONCE per process; the sampling target is
  // the most recently initialised LIVE session whose client declares the sampling
  // capability; a session without sampling never takes the target; when the target
  // session is disposed, switch to another live session with sampling, or, if none,
  // run hooks without sampling (static rules); never call a disposed session's server.
  const candidates = new Map<string, SamplingCandidate>();
  let samplingOrder = 0;
  let hooksListening = false;
  let bootStarted = false;
  let ready: Promise<void> = Promise.resolve();
  let schedulerTimer: ReturnType<typeof setInterval> | undefined;

  const pickSamplingTarget = (): Server | null => {
    const best = [...candidates.values()]
      .filter((candidate) => candidate.sampling)
      .reduce<SamplingCandidate | undefined>((current, candidate) => {
        if (!current || candidate.order > current.order) return candidate;
        return current;
      }, undefined);
    return best?.server ?? null;
  };

  const applySamplingTarget = (): void => {
    if (!hooksListening) return;
    hooks.setSamplingTarget(pickSamplingTarget());
  };

  const armScheduler = (): void => {
    if (schedulerTimer) return;
    schedulerTimer = setInterval(() => {
      scheduler.checkAndSend().catch(() => {});
    }, SCHEDULER_INTERVAL_MS);
    schedulerTimer.unref();
    scheduler.checkAndSend().catch(() => {});
  };

  const bootWriters = async (fallback: Server): Promise<void> => {
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
      hooks.setMailArrival(mailArrival);
      if (mailArrival && !options.config.settings.watcher.enabled) {
        await mcpLog(
          'warning',
          'server',
          'system_one is enabled but watcher is off — no arrivals will be classified',
        );
      }

      const started = await maybeStartMailboxWriters(canWrite, {
        startHooks: () => {
          // Register hooks once for the process so the HTTP path also wires up
          // email:new → sampling/createMessage. Without this, only stdio mode
          // triggered the hooks (see 36eb8ca).
          const target = pickSamplingTarget();
          hooks.start(target ?? fallback, { sampling: target !== null });
          hooks.setSamplingTarget(target);
          hooksListening = true;
        },
        startWatcher: async () => {
          await watcher.start();
        },
        startScheduler: () => {
          armScheduler();
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
  };

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
        // SDK binds one transport per McpServer.
        const mcpServer = createServer();
        const scope = createHttpSessionScope({
          id: sid,
          server: mcpServer.server,
          events,
          smtp,
          scheduler,
          onDispose: () => {
            candidates.delete(sid);
            applySamplingTarget();
          },
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
        bindServer(mcpServer);
        registerAllTools(
          mcpServer,
          options.connections,
          options.imap,
          smtp,
          options.config,
          options.templateService,
          options.calendarService,
          options.localCalendarService,
          options.remindersService,
          scheduler,
          watcher,
          hooks,
        );
        registerAllResources(
          mcpServer,
          options.connections,
          options.imap,
          options.templateService,
          scheduler,
        );
        registerAllPrompts(mcpServer);
        await mcpServer.connect(newTransport);

        const ls = mcpServer.server;
        ls.oninitialized = () => {
          markInitialized();
          scope.attachClient();
          candidates.set(sid, {
            server: ls,
            sampling: (ls.getClientCapabilities?.()?.sampling ?? null) != null,
            order: samplingOrder,
          });
          samplingOrder += 1;
          if (!bootStarted) {
            bootStarted = true;
            ready = bootWriters(ls);
          } else {
            applySamplingTarget();
          }
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
    get ready() {
      return ready;
    },
    scheduler,
    events,
    async close() {
      await Promise.allSettled(sessions.values().map(async (transport) => transport.close()));
      if (schedulerTimer) {
        clearInterval(schedulerTimer);
        schedulerTimer = undefined;
      }
      hooks.stop();
      await watcher.stop();
      await Promise.allSettled(disposing);
      await Promise.allSettled([...scopes.values()].map(async (scope) => scope.dispose()));
    },
  };
}
