/**
 * The IMAP/SMTP services every entry point builds from the config. The cron
 * check once built its own and lost OAuth and `save_to_sent` on the way.
 */

import ConnectionManager from '../connections/manager.js';
import RateLimiter from '../safety/rate-limiter.js';
import type { AppConfig } from '../types/index.js';
import ImapService from './imap.service.js';
import OAuthService from './oauth.service.js';
import SmtpService from './smtp.service.js';

export interface MailConnections {
  connections: ConnectionManager;
  imap: ImapService;
}

export interface MailServices extends MailConnections {
  smtp: SmtpService;
}

export function createMailConnections(config: AppConfig): MailConnections {
  const connections = new ConnectionManager(
    config.accounts,
    new OAuthService(),
    config.settings.defaultAccount,
  );
  return { connections, imap: new ImapService(connections) };
}

export function createMailServices(config: AppConfig): MailServices {
  const { connections, imap } = createMailConnections(config);
  const smtp = new SmtpService(
    connections,
    new RateLimiter(config.settings.rateLimit),
    imap,
    config.settings.saveToSent,
  );
  return { connections, imap, smtp };
}
