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
import { bindServer, markInitialized, mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import { createHttpMcpHost } from './safety/http-mcp-host.js';
import {
  formatHttpListenLines,
  readHttpLaunchOptions,
  startGuardedHttpServers,
} from './safety/http-transport.js';
import type { ShutdownStep } from './safety/shutdown.js';
import createShutdown from './safety/shutdown.js';
import attachStdioShutdown from './safety/stdio-lifecycle.js';
import type { MailboxWriterStarts } from './safety/write-side-effects.js';
import { maybeStartMailboxWriters } from './safety/write-side-effects.js';
import type { WriterLease } from './safety/writer-lease.js';
import { createWriterLease, WRITER_LEASE_FILE } from './safety/writer-lease.js';
import createServer, { PKG_VERSION } from './server.js';
import CalendarService from './services/calendar.service.js';
import HooksService from './services/hooks.service.js';
import LocalCalendarService from './services/local-calendar.service.js';
import { MailArrival } from './services/mail-arrival/index.js';
import { createMailConnections, createMailServices } from './services/mail-services.js';
import RemindersService from './services/reminders.service.js';
import SchedulerService, { startSchedulerLoop } from './services/scheduler.service.js';
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

function exitProcess(code: number): void {
  process.exit(code); // eslint-disable-line n/no-process-exit -- open IMAP handles would otherwise pin the event loop
}

function reportToStderr(message: string): void {
  process.stderr.write(`[mailoo] ${message}\n`);
}

async function runServer(): Promise<void> {
  const config = await loadConfig();

  const { connections, imap: imapService, smtp: smtpService } = createMailServices(config);
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

  let stopScheduler: (() => void) | undefined;
  let writerLease: WriterLease | undefined;

  const lowLevelServer = server.server;

  const canWrite = !config.settings.readOnly;

  const mailboxWriters: MailboxWriterStarts = {
    startHooks: () => {
      const clientCaps = lowLevelServer.getClientCapabilities?.() ?? {};
      hooksService.start(lowLevelServer, { sampling: clientCaps.sampling != null });
    },
    startWatcher: async () => watcherService.start(),
    startScheduler: () => {
      const log = async (level: 'info' | 'warning', message: string) => {
        await mcpLog(level, 'scheduler', message);
      };
      stopScheduler = startSchedulerLoop(schedulerService, log);
    },
  };
  const mailboxWriterStops: ShutdownStep[] = [
    ['scheduler', () => stopScheduler?.()],
    ['hooks', () => hooksService.stop()],
    ['watcher', async () => watcherService.stop()],
  ];

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

        if (canWrite) {
          writerLease = createWriterLease({
            lockPath: WRITER_LEASE_FILE,
            onLead: async () => {
              await maybeStartMailboxWriters(canWrite, mailboxWriters);
              await mcpLog('info', 'server', 'This process runs hooks, watcher, and scheduler');
            },
            onLose: async () => {
              await mailboxWriterStops.reduce(async (previous, [, stop]) => {
                await previous;
                await stop();
              }, Promise.resolve());
              await mcpLog(
                'warning',
                'server',
                'Another Mailoo process took over hooks, watcher, and scheduler',
              );
            },
            report: (message) => {
              mcpLog('warning', 'server', message).catch(() => undefined);
            },
          });
          await writerLease.start();
          if (!writerLease.leading) {
            await mcpLog(
              'info',
              'server',
              'Another Mailoo process runs hooks, watcher, and scheduler; this one takes over when it stops',
            );
          }
        } else {
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

  const shutdown = createShutdown(
    [
      // Halt first so this process cannot win the lease mid-shutdown, and
      // release only after its writers stopped so the next leader never overlaps them.
      ['writer lease', async () => writerLease?.halt()],
      ...mailboxWriterStops,
      ['writer lease release', async () => writerLease?.release()],
      ['connections', async () => connections.closeAll()],
      ['server', async () => server.close()],
    ],
    { exit: exitProcess, report: reportToStderr },
  );

  attachStdioShutdown(process.stdin, shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
}

async function runHttpServer(policy: ReturnType<typeof readHttpLaunchOptions>): Promise<void> {
  const config = await loadConfig();

  // One bearer token is one principal. The host keeps the rate limit, schedule
  // queue, watcher, and hooks process-wide, as on stdio. Each HTTP session only
  // owns an McpServer and its transport.
  const { connections, imap: imapService } = createMailConnections(config);
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

  const shutdown = createShutdown(
    [
      ['host', async () => host.close()],
      ['connections', async () => connections.closeAll()],
      ['listener', async () => listener.close()],
    ],
    { exit: exitProcess, report: reportToStderr },
  );

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
