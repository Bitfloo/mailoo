/**
 * Streamable HTTP entry. One bearer token is one principal, so account
 * state is process-wide. Each session owns an McpServer and a transport.
 * Idle sessions are closed by the session table.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { SCHEDULED_DIR } from '../config/xdg.js';
import type ConnectionManager from '../connections/manager.js';
import { mcpLog } from '../logging.js';
import { PKG_VERSION } from '../server.js';
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
import type { AppConfig } from '../types/index.js';
import type { HttpSessionScope } from './http-session-scope.js';
import type { OpenedSession, SessionLifecycle } from './http-session-setup.js';
import openSession from './http-session-setup.js';
import HttpSessionStore, {
  DEFAULT_HTTP_MAX_SESSIONS,
  DEFAULT_HTTP_SESSION_TTL_MS,
} from './http-sessions.js';
import { readLimitedBody, resolveHttpRoute, rpcErrorBody } from './http-transport.js';
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

function sendRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(rpcErrorBody(code, message));
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
  });

  const sessions = new HttpSessionStore<StreamableHTTPServerTransport>(
    options.maxSessions ?? DEFAULT_HTTP_MAX_SESSIONS,
    options.ttlMs ?? DEFAULT_HTTP_SESSION_TTL_MS,
    options.now,
  );
  const scopes = new Map<string, HttpSessionScope>();
  const disposing = new Set<Promise<void>>();
  const canWrite = !options.config.settings.readOnly;

  // Never call a disposed session's server. The newest sampling client wins
  // because older sessions may be idle until the TTL closes them.
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

  // Node ends the process on an unhandled rejection, so a failed dispose is
  // reported here. A settled entry leaves the set: a long-lived host would
  // otherwise keep one promise per closed session.
  const trackDispose = (scope: HttpSessionScope): void => {
    const pending: Promise<void> = scope
      .dispose()
      .catch((err: unknown) => {
        process.stderr.write(
          `[mailoo] HTTP session dispose failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      })
      .finally(() => {
        disposing.delete(pending);
      });
    disposing.add(pending);
  };

  const release = (sid: string, scope: HttpSessionScope): void => {
    sessions.delete(sid);
    scopes.delete(sid);
    trackDispose(scope);
  };

  const services = { ...options, events, smtp, scheduler, watcher, hooks };
  const lifecycle: SessionLifecycle = {
    registered: (id, transport, scope) => {
      sessions.set(id, transport);
      scopes.set(id, scope);
      sessions.beginRequest(id);
    },
    closed: release,
    disposed: (sid) => {
      candidates.delete(sid);
      applySamplingTarget();
    },
    initialized: (sid, server) => {
      candidates.set(sid, {
        server,
        sampling: (server.getClientCapabilities?.()?.sampling ?? null) != null,
        order: samplingOrder,
      });
      samplingOrder += 1;
      if (!bootStarted) {
        bootStarted = true;
        ready = bootWriters(server);
      } else {
        applySamplingTarget();
      }
    },
    abandoned: trackDispose,
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const route = resolveHttpRoute(req.method, req.url);
    // Only /health gets here: the guard refuses methods outside GET, POST and DELETE first.
    if (route === 'method') {
      res.writeHead(405, { Allow: 'GET' });
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
          sendRpcError(res, 400, -32700, 'Parse error');
          return;
        }
      }
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    let transport: StreamableHTTPServerTransport;
    let opened: OpenedSession | undefined;

    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !existing) {
      // Streamable HTTP: 404 tells the client its session is gone and it must
      // initialize again. A 400 left a client evicted by the idle TTL stuck.
      sendRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    if (existing && sessionId) {
      transport = existing;
      sessions.touch(sessionId);
      sessions.beginRequest(sessionId);
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
      opened = await openSession(services, lifecycle);
      transport = opened.transport;
    } else {
      sendRpcError(
        res,
        400,
        -32000,
        'Bad Request: provide mcp-session-id or send an initialize request',
      );
      return;
    }

    try {
      await transport.handleRequest(req, res, body);
    } finally {
      const trackedId = sessionId ?? opened?.registration.id;
      if (trackedId) sessions.endRequest(trackedId);
      if (opened && opened.registration.id === undefined) trackDispose(opened.scope);
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
      await Promise.allSettled([...disposing]);
      await Promise.allSettled([...scopes.values()].map(async (scope) => scope.dispose()));
    },
  };
}
