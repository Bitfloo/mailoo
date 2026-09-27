/**
 * Per-client state for one Streamable HTTP session.
 * Watchers, resource updates, rate limits, and scheduled mail stay inside
 * that session and are removed when the session is closed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { IConnectionManager } from '../connections/types.js';
import { EmailEventBus } from '../services/event-bus.js';
import HooksService from '../services/hooks.service.js';
import type ImapService from '../services/imap.service.js';
import SchedulerService from '../services/scheduler.service.js';
import SmtpService from '../services/smtp.service.js';
import WatcherService from '../services/watcher.service.js';
import type { AccountConfig, HooksConfig, WatcherConfig } from '../types/index.js';
import RateLimiter from './rate-limiter.js';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SCHEDULER_INTERVAL_MS = 60_000;

export interface HttpSessionScope {
  readonly id: string;
  readonly queueDir: string;
  readonly rateLimiter: RateLimiter;
  readonly smtp: SmtpService;
  readonly scheduler: SchedulerService;
  readonly watcher: WatcherService;
  readonly hooks: HooksService;
  readonly events: EmailEventBus;
  armScheduler: () => void;
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
  queueDir: string;
  rateLimit: number;
  saveToSent: boolean;
  watcher: WatcherConfig;
  accounts: AccountConfig[];
  hooks: HooksConfig;
  connections: IConnectionManager;
  imap: ImapService;
}): HttpSessionScope {
  const events = new EmailEventBus();
  const rateLimiter = new RateLimiter(input.rateLimit);
  const smtp = new SmtpService(input.connections, rateLimiter, input.imap, input.saveToSent);
  const scheduler = new SchedulerService(smtp, input.imap, input.queueDir);
  const watcher = new WatcherService(input.watcher, input.accounts, events);
  const hooks = new HooksService(input.hooks, input.imap, { events });

  let disposed = false;
  let schedulerTimer: ReturnType<typeof setInterval> | undefined;
  let disposePromise: Promise<void> | undefined;

  return {
    id: input.id,
    queueDir: input.queueDir,
    rateLimiter,
    smtp,
    scheduler,
    watcher,
    hooks,
    events,
    armScheduler() {
      if (disposed || schedulerTimer) return;
      schedulerTimer = setInterval(() => {
        if (disposed) return;
        scheduler.checkAndSend().catch(() => {});
      }, SCHEDULER_INTERVAL_MS);
      schedulerTimer.unref();
      scheduler.checkAndSend().catch(() => {});
    },
    async dispose() {
      disposePromise ??= (async () => {
        disposed = true;
        if (schedulerTimer) {
          clearInterval(schedulerTimer);
          schedulerTimer = undefined;
        }
        hooks.stop();
        await watcher.stop();
        events.removeAllListeners();
        await fs.rm(input.queueDir, { recursive: true, force: true });
      })();
      await disposePromise;
    },
  };
}
