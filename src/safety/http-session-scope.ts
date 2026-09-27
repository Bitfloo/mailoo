/**
 * Per-session MCP objects for one Streamable HTTP client.
 * Account state stays on the process. Dispose does not close shared
 * connections.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { EmailEventBus } from '../services/event-bus.js';
import type SchedulerService from '../services/scheduler.service.js';
import type SmtpService from '../services/smtp.service.js';

export interface HttpSessionScope {
  readonly id: string;
  readonly events: EmailEventBus;
  readonly smtp: SmtpService;
  readonly scheduler: SchedulerService;
  readonly server: Server;
  dispose: () => Promise<void>;
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
