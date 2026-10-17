/**
 * MCP protocol logging bridge.
 *
 * Forwards structured log messages to the connected MCP client
 * via the logging notification channel declared in server capabilities.
 *
 * Messages are silently dropped until `markInitialized()` is called,
 * which should happen only after the MCP `initialized` handshake
 * completes.  This prevents pre-handshake notifications from being
 * written to stdout and breaking clients.
 *
 * Usage:
 *   bindServer(server)       — call after creating each McpServer
 *   markInitialized(server)  — call from that server's `oninitialized` callback
 *   unbindServer(server)     — call when an HTTP session is disposed
 *   mcpLog("info", …)        — fire-and-forget from anywhere
 *
 * Logs are process-wide (one principal), so every live, initialized session
 * receives them.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type LogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

/** Bound servers; the value is `true` once that client completed the `initialized` handshake. */
const servers = new Map<McpServer, boolean>();

/**
 * Bind an McpServer instance so subsequent `mcpLog()` calls
 * are forwarded to its client once it is marked initialized.
 */
export function bindServer(server: McpServer): void {
  if (!servers.has(server)) servers.set(server, false);
}

export function unbindServer(server: McpServer): void {
  servers.delete(server);
}

/**
 * Mark a server as fully initialized (handshake complete).
 *
 * Call this from the `server.server.oninitialized` callback so that
 * `mcpLog()` starts forwarding messages to the client. Without an argument
 * it marks every bound server, which is the single stdio server.
 */
export function markInitialized(server?: McpServer): void {
  if (server) {
    if (servers.has(server)) servers.set(server, true);
    return;
  }
  [...servers.keys()].forEach((bound) => {
    servers.set(bound, true);
  });
}

/**
 * Number of bound servers. Exported for tests only: they prove a disposed
 * session's server is released, which no log output can show.
 * @internal
 */
export function boundServerCount(): number {
  return servers.size;
}

/**
 * Reset module state.  **Test-only** — never call in production.
 * @internal
 */
// eslint-disable-next-line @typescript-eslint/naming-convention, no-underscore-dangle
export function __resetForTesting(): void {
  servers.clear();
}

/**
 * Emit a structured log message over the MCP logging channel.
 *
 * Safe to call at any point — a server is skipped when:
 *   • it hasn't been bound, or was unbound
 *   • its transport isn't connected
 *   • its MCP handshake hasn't completed (`markInitialized()` not called)
 */
export async function mcpLog(level: LogLevel, logger: string, data: unknown): Promise<void> {
  const targets = [...servers]
    .filter(([server, initialized]) => initialized && server.isConnected())
    .map(([server]) => server);
  await Promise.all(
    targets.map(async (server) => {
      try {
        await server.sendLoggingMessage({ level, logger, data });
      } catch {
        // Never let a logging failure break tool execution
      }
    }),
  );
}
