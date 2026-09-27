#!/usr/bin/env node
/**
 * Mailoo — Main entry point.
 *
 * Subcommands:
 *   stdio     Run as MCP server over stdio (default)
 *   http      Run as MCP server over Streamable HTTP (loopback, port 8080)
 *   setup     Interactive account setup wizard
 *   test      Test IMAP/SMTP connections
 *   config    Config management (show, path, init)
 *   scheduler Email scheduling management
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig } from './config/loader.js';
import ConnectionManager from './connections/manager.js';
import { bindServer, markInitialized, mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import { createHttpMcpHost } from './safety/http-mcp-host.js';
import {
  formatHttpListenLines,
  readHttpLaunchOptions,
  startGuardedHttpServers,
} from './safety/http-transport.js';
import RateLimiter from './safety/rate-limiter.js';
import attachStdioShutdown from './safety/stdio-lifecycle.js';
import { maybeStartMailboxWriters } from './safety/write-side-effects.js';
import createServer, { PKG_VERSION } from './server.js';
import CalendarService from './services/calendar.service.js';
import HooksService from './services/hooks.service.js';
import ImapService from './services/imap.service.js';
import LocalCalendarService from './services/local-calendar.service.js';
import { MailArrival } from './services/mail-arrival/index.js';
import OAuthService from './services/oauth.service.js';
import RemindersService from './services/reminders.service.js';
import SchedulerService from './services/scheduler.service.js';
import SmtpService from './services/smtp.service.js';
import TemplateService from './services/template.service.js';
import WatcherService from './services/watcher.service.js';
import registerAllTools from './tools/register.js';

const HELP = `
mailoo — IMAP/SMTP MCP server

Usage:
  mailoo [command]

Commands:
  stdio       Run as MCP server over stdio (default)
  http [port] [host]  Streamable HTTP (default: port 8080 on 127.0.0.1 and ::1)
  account     Account management (list, add, edit, delete)
  setup       Alias for 'account add'
  test        Test connections for all or a specific account
  install     Register/unregister with MCP clients (Claude, Cursor, …)
  config      Config management (show, edit, path, init)
  scheduler   Email scheduling management (check, list, install, uninstall, status)
  notify      Test and diagnose desktop notifications
  help        Show this help message

Examples:
  mailoo                         # Start MCP server (stdio)
  mailoo http                    # Loopback HTTP on port 8080 (127.0.0.1 and ::1)
  mailoo http 9090               # Loopback HTTP on port 9090
  mailoo account list             # List configured accounts
  mailoo account add              # Add a new email account
  mailoo account edit personal    # Edit an account
  mailoo account delete work      # Delete an account
  mailoo setup                    # Alias for account add
  mailoo test                     # Test all accounts
  mailoo test personal            # Test specific account
  mailoo install                  # Register with detected MCP clients
  mailoo install status           # Show client registration status
  mailoo install remove           # Unregister from MCP clients
  mailoo config show              # Show config (passwords masked)
  mailoo config edit              # Edit global settings
  mailoo config path              # Print config file path
  mailoo config init              # Create template config
  mailoo scheduler check          # Send overdue scheduled emails
  mailoo scheduler install        # Install OS periodic check
  mailoo notify test              # Send a test notification
  mailoo notify status            # Check notification platform support
`.trim();

async function runServer(): Promise<void> {
  const config = await loadConfig();

  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);
  const smtpService = new SmtpService(
    connections,
    rateLimiter,
    imapService,
    config.settings.saveToSent,
  );
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const remindersService = new RemindersService();
  const schedulerService = new SchedulerService(smtpService, imapService);
  const watcherService = new WatcherService(config.settings.watcher, config.accounts);
  const hooksService = new HooksService(config.settings.hooks, imapService);

  const server = createServer();
  bindServer(server);

  registerAllTools(
    server,
    connections,
    imapService,
    smtpService,
    config,
    templateService,
    calendarService,
    localCalendarService,
    remindersService,
    schedulerService,
    watcherService,
    hooksService,
  );
  registerAllResources(server, connections, imapService, templateService, schedulerService);
  registerAllPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // --- Post-handshake initialization ----------------------------------------
  // Everything below is deferred until the client completes the MCP
  // `initialize` / `initialized` handshake.  This prevents notifications
  // from being written to stdout before the client is ready, which would
  // crash clients like Vibe, and ensures `getClientCapabilities()` returns
  // the real capabilities (including `sampling` support).
  // --------------------------------------------------------------------------

  let schedulerInterval: ReturnType<typeof setInterval> | undefined;

  const lowLevelServer = server.server;

  const canWrite = !config.settings.readOnly;

  lowLevelServer.oninitialized = () => {
    markInitialized();

    // eslint-disable-next-line no-void
    void (async () => {
      try {
        const mailArrival = await MailArrival.tryCreate({
          config: config.settings.systemOne,
          imap: imapService,
          apiKey: process.env.TYPESAFE_API_KEY,
          accounts: config.accounts,
          moveToPaths: config.settings.hooks.rules
            .map((rule) => rule.actions.moveTo)
            .filter((path): path is string => Boolean(path)),
        });
        hooksService.setMailArrival(mailArrival);
        if (mailArrival && !config.settings.watcher.enabled) {
          await mcpLog(
            'warning',
            'server',
            'system_one is enabled but watcher is off — no arrivals will be classified',
          );
        }

        const started = await maybeStartMailboxWriters(canWrite, {
          startHooks: () => {
            const clientCaps = lowLevelServer.getClientCapabilities?.() ?? {};
            hooksService.start(lowLevelServer, { sampling: clientCaps.sampling != null });
          },
          startWatcher: async () => watcherService.start(),
          startScheduler: async () => {
            try {
              const result = await schedulerService.checkAndSend();
              if (result.sent > 0) {
                await mcpLog(
                  'info',
                  'scheduler',
                  `Sent ${result.sent} overdue email(s) on startup`,
                );
              }
            } catch {
              // Non-fatal: scheduler check failure shouldn't prevent server start
            }

            schedulerInterval = setInterval(async () => {
              try {
                await schedulerService.checkAndSend();
              } catch {
                // Silent — don't spam logs
              }
            }, 60_000);
            schedulerInterval.unref();
          },
        });

        if (!started) {
          await mcpLog(
            'info',
            'server',
            'read_only: skipping hooks, watcher, and scheduler (no mailbox writes)',
          );
        }

        await mcpLog('info', 'server', 'Mailoo started');
      } catch (err) {
        // Log to stderr — mcpLog may not be safe if init itself errored
        process.stderr.write(
          `[mailoo] post-init error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    })();
  };

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (schedulerInterval) clearInterval(schedulerInterval);
    hooksService.stop();
    await watcherService.stop();
    await connections.closeAll();
    await server.close();
    process.exit(0); // eslint-disable-line n/no-process-exit -- stdio EOF must terminate; IMAP handles would pin the loop
  };

  attachStdioShutdown(process.stdin, shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

async function runHttpServer(policy: ReturnType<typeof readHttpLaunchOptions>): Promise<void> {
  const config = await loadConfig();

  // Account connections stay process-wide. Session-owned state is created
  // inside createHttpMcpHost so one HTTP client cannot see another's.
  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const imapService = new ImapService(connections);
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const remindersService = new RemindersService();
  const host = await createHttpMcpHost({
    config,
    connections,
    imap: imapService,
    templateService,
    calendarService,
    localCalendarService,
    remindersService,
    bodyLimitBytes: policy.bodyLimitBytes,
  });

  const listener = await startGuardedHttpServers(policy, host.handle);
  process.stderr.write(`${formatHttpListenLines(listener.addresses)}\n`);

  const shutdown = async () => {
    await host.close();
    await connections.closeAll();
    await listener.close();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'stdio';

  switch (command) {
    case 'stdio':
      await runServer();
      break;

    case 'http': {
      let policy: ReturnType<typeof readHttpLaunchOptions>;
      try {
        policy = readHttpLaunchOptions(
          { portArg: process.argv[3], hostArg: process.argv[4] },
          process.env,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        throw new Error(message);
      }
      await runHttpServer(policy);
      break;
    }

    case 'setup': {
      const { default: runSetup } = await import('./cli/setup.js');
      await runSetup();
      break;
    }

    case 'account': {
      const { default: runAccountCommand } = await import('./cli/account-commands.js');
      await runAccountCommand(process.argv[3], process.argv[4]);
      break;
    }

    case 'test': {
      const { default: runTest } = await import('./cli/test.js');
      await runTest(process.argv[3]);
      break;
    }

    case 'config': {
      const { default: runConfigCommand } = await import('./cli/config-commands.js');
      await runConfigCommand(process.argv[3]);
      break;
    }

    case 'install': {
      const { default: runInstallCommand } = await import('./cli/install-commands.js');
      await runInstallCommand(process.argv[3]);
      break;
    }

    case 'scheduler': {
      const { default: runSchedulerCommand } = await import('./cli/scheduler.js');
      await runSchedulerCommand(process.argv[3]);
      break;
    }

    case 'notify': {
      const { default: runNotifyCommand } = await import('./cli/notify.js');
      await runNotifyCommand(process.argv[3]);
      break;
    }

    case '--version':
    case '-v':
      console.log(PKG_VERSION);
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
