/**
 * Builds one Streamable HTTP session: its McpServer, scope and transport,
 * with logging bound for the session's lifetime. The host keeps the session
 * table and the sampling target, and learns about each step by callback.
 */

import { randomUUID } from 'node:crypto';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type ConnectionManager from '../connections/manager.js';
import { bindServer, markInitialized, unbindServer } from '../logging.js';
import registerAllPrompts from '../prompts/register.js';
import registerAllResources from '../resources/register.js';
import createServer from '../server.js';
import type CalendarService from '../services/calendar.service.js';
import type { EmailEventBus } from '../services/event-bus.js';
import type HooksService from '../services/hooks.service.js';
import type ImapService from '../services/imap.service.js';
import type LocalCalendarService from '../services/local-calendar.service.js';
import type RemindersService from '../services/reminders.service.js';
import type SchedulerService from '../services/scheduler.service.js';
import type SmtpService from '../services/smtp.service.js';
import type TemplateService from '../services/template.service.js';
import type WatcherService from '../services/watcher.service.js';
import registerAllTools from '../tools/register.js';
import type { AppConfig } from '../types/index.js';
import type { HttpSessionScope } from './http-session-scope.js';
import { createHttpSessionScope } from './http-session-scope.js';

/** A session an initialize request is opening; `id` is set once the transport registers it. */
export interface OpenedSession {
  transport: StreamableHTTPServerTransport;
  scope: HttpSessionScope;
  registration: { id?: string };
}

/** Process-wide services every session shares. */
export interface SessionServices {
  config: AppConfig;
  connections: ConnectionManager;
  imap: ImapService;
  templateService: TemplateService;
  calendarService: CalendarService;
  localCalendarService: LocalCalendarService;
  remindersService: RemindersService;
  events: EmailEventBus;
  smtp: SmtpService;
  scheduler: SchedulerService;
  watcher: WatcherService;
  hooks: HooksService;
}

export interface SessionLifecycle {
  registered: (
    id: string,
    transport: StreamableHTTPServerTransport,
    scope: HttpSessionScope,
  ) => void;
  closed: (id: string, scope: HttpSessionScope) => void;
  disposed: (sid: string) => void;
  initialized: (sid: string, server: Server) => void;
  /** Setup failed before the transport registered the session. */
  abandoned: (scope: HttpSessionScope) => void;
}

export default async function openSession(
  services: SessionServices,
  lifecycle: SessionLifecycle,
): Promise<OpenedSession> {
  const sid = randomUUID();
  // SDK binds one transport per McpServer.
  const mcpServer = createServer();
  const scope = createHttpSessionScope({
    id: sid,
    server: mcpServer.server,
    events: services.events,
    smtp: services.smtp,
    scheduler: services.scheduler,
    onDispose: () => {
      unbindServer(mcpServer);
      lifecycle.disposed(sid);
    },
  });
  const registration: OpenedSession['registration'] = {};
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sid,
      onsessioninitialized: (initializedId) => {
        lifecycle.registered(initializedId, transport, scope);
        registration.id = initializedId;
      },
    });
    transport.onclose = () => {
      lifecycle.closed(transport.sessionId ?? sid, scope);
    };
    bindServer(mcpServer);
    registerAllTools(
      mcpServer,
      services.connections,
      services.imap,
      services.smtp,
      services.config,
      services.templateService,
      services.calendarService,
      services.localCalendarService,
      services.remindersService,
      services.scheduler,
      services.watcher,
      services.hooks,
    );
    registerAllResources(
      mcpServer,
      services.connections,
      services.imap,
      services.templateService,
      services.scheduler,
    );
    registerAllPrompts(mcpServer);
    await mcpServer.connect(transport);

    const ls = mcpServer.server;
    ls.oninitialized = () => {
      markInitialized(mcpServer);
      lifecycle.initialized(sid, ls);
    };

    return { transport, scope, registration };
  } catch (err) {
    if (registration.id === undefined) lifecycle.abandoned(scope);
    throw err;
  }
}
