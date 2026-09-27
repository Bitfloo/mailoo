/**
 * Per-session MCP objects for one Streamable HTTP client.
 * Account state stays on the process. Dispose does not close shared
 * connections. Session id checks stay here because the id is the session key.
 */

import path from 'node:path';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { EmailEventBus } from '../services/event-bus.js';
import type SchedulerService from '../services/scheduler.service.js';
import type SmtpService from '../services/smtp.service.js';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HttpSessionScope {
  readonly id: string;
  readonly events: EmailEventBus;
  readonly smtp: SmtpService;
  readonly scheduler: SchedulerService;
  readonly server: Server;
  dispose: () => Promise<void>;
}

export function httpSessionQueueDir(root: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid HTTP session id');
  }
  const base = path.resolve(root);
  const dir = path.resolve(base, sessionId);
  const relative = path.relative(base, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('Invalid HTTP session id');
  }
  return dir;
}

export function createHttpSessionScope(input: {
  id: string;
  server: Server;
  events: EmailEventBus;
  smtp: SmtpService;
  scheduler: SchedulerService;
  onDispose: () => void;
}): HttpSessionScope {
  let disposePromise: Promise<void> | undefined;

  return {
    id: input.id,
    events: input.events,
    smtp: input.smtp,
    scheduler: input.scheduler,
    server: input.server,
    async dispose() {
      disposePromise ??= Promise.resolve().then(() => {
        input.onDispose();
      });
      await disposePromise;
    },
  };
}
