/**
 * Accounts and a started-watcher helper for the watcher suites, which run against the
 * in-memory server in `fake-imapflow.ts`. Split from it because this module loads imapflow.
 */

import type { AccessTokenSource } from '../connections/types.js';
import type { NewEmailEvent } from '../services/event-bus.js';
import { EmailEventBus } from '../services/event-bus.js';
import WatcherService from '../services/watcher.service.js';
import type { AccountConfig, WatcherConfig } from '../types/index.js';

export const testAccount: AccountConfig = {
  name: 'test',
  email: 'test@example.com',
  username: 'test@example.com',
  password: 'password',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

// OAuth accounts carry no password: the config schema leaves it empty for oauth2 accounts.
export const oauthAccount: AccountConfig = {
  ...testAccount,
  name: 'work',
  password: undefined,
  oauth2: {
    provider: 'google',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
  },
};

export const inboxOnly: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };

const running: WatcherService[] = [];

export function watch(
  config: WatcherConfig = inboxOnly,
  accounts: AccountConfig[] = [testAccount],
  tokens?: AccessTokenSource,
): { watcher: WatcherService; arrivals: NewEmailEvent[] } {
  const events = new EmailEventBus();
  const arrivals: NewEmailEvent[] = [];
  events.on('email:new', (event) => {
    arrivals.push(event);
  });
  const watcher = new WatcherService(config, accounts, events, tokens);
  running.push(watcher);
  return { watcher, arrivals };
}

/**
 * The watcher suites' teardown. Spies are restored before real timers come back: restoring a
 * spy on a faked timer afterwards would put the fake on globalThis for every later test.
 */
export async function tearDownWatchers(): Promise<void> {
  await Promise.all(running.splice(0).map(async (watcher) => watcher.stop()));
  vi.restoreAllMocks();
  vi.useRealTimers();
}

export function arrivedIds(arrivals: NewEmailEvent[]): string[] {
  return arrivals.flatMap((arrival) => arrival.emails.map((email) => email.id));
}

export function arrivedSubjects(arrivals: NewEmailEvent[]): string[] {
  return arrivals.flatMap((arrival) => arrival.emails.map((email) => email.subject));
}
