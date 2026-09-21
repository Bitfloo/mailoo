#!/usr/bin/env node
/**
 * Mailoo — Main entry point.
 *
 * Subcommands:
 *   stdio     Run as MCP server over stdio (default)
 *   http      Run as MCP server over Streamable HTTP (port 8080 by default)
 *   setup     Interactive account setup wizard
 *   test      Test IMAP/SMTP connections
 *   config    Config management (show, path, init)
 *   scheduler Email scheduling management
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './config/loader.js';
import ConnectionManager from './connections/manager.js';
import { bindServer, markInitialized, mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import HttpSessionStore from './safety/http-sessions.js';
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
  http [port] Run as MCP server over Streamable HTTP (default port: 8080)
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
  mailoo http                    # Start HTTP server on port 8080
  mailoo http 9090               # Start HTTP server on port 9090
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

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function runHttpServer(port: number): Promise<void> {
  const config = await loadConfig();

  // Shared services — created once for the process lifetime
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

  // Per-session factory: tools share service instances but each MCP session
  // needs its own McpServer because the SDK binds one transport per server.
  function buildMcpSession() {
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
    return server;
  }

  const sessions = new HttpSessionStore<StreamableHTTPServerTransport>();
  const canWrite = !config.settings.readOnly;

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: PKG_VERSION }));
      return;
    }

    if (req.url !== '/mcp') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      const raw = await readBody(req);
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

    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing && sessionId) {
      transport = existing;
      sessions.touch(sessionId);
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, newTransport);
        },
      });
      newTransport.onclose = () => {
        const sid = newTransport.sessionId;
        if (sid) sessions.delete(sid);
      };
      const mcpServer = buildMcpSession();
      await mcpServer.connect(newTransport);

      // Register hooks on the *first* client init for this session so the
      // HTTP path also wires up email:new → sampling/createMessage. Without
      // this, only stdio mode triggered the hooks (see 36eb8ca on main).
      const ls = mcpServer.server;
      ls.oninitialized = () => {
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
                const clientCaps = ls.getClientCapabilities?.() ?? {};
                hooksService.start(ls, { sampling: clientCaps.sampling != null });
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
        })();
      };

      transport = newTransport;
      trackedId = newTransport.sessionId;
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

    if (trackedId) sessions.beginRequest(trackedId);
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      if (trackedId) sessions.endRequest(trackedId);
      sessions.evict();
    }
  });

  let checkInterval: ReturnType<typeof setInterval> | undefined;
  await maybeStartMailboxWriters(canWrite, {
    startWatcher: async () => watcherService.start(),
    startScheduler: async () => {
      checkInterval = setInterval(async () => {
        try {
          await schedulerService.checkAndSend();
        } catch {
          // Silent
        }
      }, 60_000);
      checkInterval.unref();

      try {
        const result = await schedulerService.checkAndSend();
        if (result.sent > 0) {
          process.stderr.write(`[scheduler] Sent ${result.sent} overdue email(s) on startup\n`);
        }
      } catch {
        // Non-fatal
      }
    },
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, () => {
      process.stderr.write(`mailoo HTTP server listening on :${port}\n`);
      process.stderr.write(`  Endpoint : http://0.0.0.0:${port}/mcp\n`);
      process.stderr.write(`  Health   : http://0.0.0.0:${port}/health\n`);
      resolve();
    });
    httpServer.once('error', reject);
  });

  const shutdown = async () => {
    if (checkInterval) clearInterval(checkInterval);
    hooksService.stop();
    await watcherService.stop();
    await Promise.allSettled(sessions.values().map(async (t) => t.close()));
    await connections.closeAll();
    httpServer.close();
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
      const portArg = process.argv[3];
      const port = portArg !== undefined ? Number.parseInt(portArg, 10) : 8080;
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${portArg}`);
        throw new Error(`Invalid port: ${portArg}`);
      }
      await runHttpServer(port);
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
